const { query, queryClient } = require('../database/query');
const { withTransaction } = require('../database/transaction');

/**
 * Tarefa agendada para apuramento de quotas de Kixikila vencidas, aplicação de tolerância,
 * penalizações de mora e emissão de alertas preventivos.
 */
class ContributionsDueJob {
  /**
   * Executa a rotina periódica de verificação de prazos de contribuição.
   *
   * @returns {Promise<{
   *   remindersSent: number,
   *   markedLate: number,
   *   markedDefaulted: number
   * }>}
   */
  async run() {
    return withTransaction(async (client) => {
      let remindersSent = 0;
      let markedLate = 0;
      let markedDefaulted = 0;

      // ------------------------------------------------------------------------
      // 1. Alertas Preventivos: Quotas a vencer hoje ou nas próximas 24 horas
      // ------------------------------------------------------------------------
      const remindersQuery = `
        SELECT 
          o.id AS obligation_id,
          o.user_id,
          o.group_id,
          o.expected_amount,
          o.due_date,
          g.name AS group_name
        FROM contribution_obligations o
        INNER JOIN groups g ON g.id = o.group_id
        WHERE o.status = 'PENDING'
          AND o.due_date <= (CURRENT_DATE + INTERVAL '1 day')
          AND o.due_date >= CURRENT_DATE
          AND NOT EXISTS (
            SELECT 1 FROM notifications n
            WHERE n.user_id = o.user_id
              AND n.event_type = 'CONTRIBUTION_DUE_ALERT'
              AND n.payload->>'obligation_id' = o.id::text
              AND n.created_at >= (NOW() AT TIME ZONE 'UTC' - INTERVAL '24 hours')
          );
      `;

      const { rows: reminderRows } = await client.query(remindersQuery);

      for (const row of reminderRows) {
        const notifQuery = `
          INSERT INTO notifications (
            user_id, title, message, event_type, channel, status, payload
          )
          VALUES ($1, $2, $3, 'CONTRIBUTION_DUE_ALERT', 'IN_APP', 'PENDING', $4);
        `;

        await queryClient(client, notifQuery, [
          row.user_id,
          'Aviso de Vencimento de Quota',
          `A sua quota no valor de ${Number(row.expected_amount).toLocaleString('pt-AO')} Kz no grupo "${row.group_name}" vence a ${row.due_date}.`,
          JSON.stringify({
            obligation_id: row.obligation_id,
            group_id: row.group_id,
            amount: row.expected_amount
          })
        ]);

        remindersSent += 1;
      }

      // ------------------------------------------------------------------------
      // 2. Transição para Mora (LATE): Vencidas mas dentro do período de carência
      // ------------------------------------------------------------------------
      const lateQuery = `
        SELECT 
          o.id AS obligation_id,
          o.user_id,
          o.group_id,
          gr.late_fee_type,
          gr.late_fee_value,
          o.expected_amount,
          g.name AS group_name
        FROM contribution_obligations o
        INNER JOIN groups g ON g.id = o.group_id
        LEFT JOIN group_rules gr ON gr.group_id = o.group_id
        WHERE o.status = 'PENDING'
          AND o.due_date < CURRENT_DATE
          AND CURRENT_DATE <= o.grace_date;
      `;

      const { rows: lateRows } = await client.query(lateQuery);

      for (const row of lateRows) {
        let assessedLateFee = 0;
        if (row.late_fee_type === 'FIXED') {
          assessedLateFee = Number(row.late_fee_value || 0);
        } else if (row.late_fee_type === 'PERCENTAGE') {
          // Pontos-base (ex: 200 = 2%)
          assessedLateFee = Math.round((Number(row.expected_amount) * Number(row.late_fee_value || 0)) / 10000);
        }

        await queryClient(
          client,
          `UPDATE contribution_obligations
           SET status = 'LATE',
               late_fee_assessed = $1,
               updated_at = NOW() AT TIME ZONE 'UTC'
           WHERE id = $2;`,
          [assessedLateFee, row.obligation_id]
        );

        // Notifica o participante sobre a entrada em mora
        await queryClient(
          client,
          `INSERT INTO notifications (
             user_id, title, message, event_type, channel, status, payload
           )
           VALUES ($1, 'Quota em Atraso', $2, 'CONTRIBUTION_DUE_ALERT', 'IN_APP', 'PENDING', $3);`,
          [
            row.user_id,
            `A sua quota no grupo "${row.group_name}" está em atraso. Regularize dentro da tolerância para evitar incumprimento definitivo.`,
            JSON.stringify({ obligation_id: row.obligation_id, lateFee: assessedLateFee })
          ]
        );

        markedLate += 1;
      }

      // ------------------------------------------------------------------------
      // 3. Incumprimento Definitivo (DEFAULTED): Prazo de tolerância esgotado
      // ------------------------------------------------------------------------
      const defaultedQuery = `
        SELECT 
          o.id AS obligation_id,
          o.user_id,
          o.group_id,
          o.membership_id,
          g.name AS group_name,
          g.leader_id
        FROM contribution_obligations o
        INNER JOIN groups g ON g.id = o.group_id
        WHERE o.status IN ('PENDING', 'LATE')
          AND CURRENT_DATE > o.grace_date;
      `;

      const { rows: defaultedRows } = await client.query(defaultedQuery);

      for (const row of defaultedRows) {
        // Marca a obrigação como incumprida
        await queryClient(
          client,
          `UPDATE contribution_obligations
           SET status = 'DEFAULTED',
               updated_at = NOW() AT TIME ZONE 'UTC'
           WHERE id = $1;`,
          [row.obligation_id]
        );

        // Atualiza o estado da filiação no grupo para DEFAULTED
        await queryClient(
          client,
          `UPDATE group_memberships
           SET status = 'DEFAULTED',
               is_contribution_restricted = TRUE,
               updated_at = NOW() AT TIME ZONE 'UTC'
           WHERE id = $1;`,
          [row.membership_id]
        );

        // Notifica o líder do grupo sobre a inadimplência confirmada
        await queryClient(
          client,
          `INSERT INTO notifications (
             user_id, title, message, event_type, channel, status, payload
           )
           VALUES ($1, 'Incumprimento de Membro', $2, 'ROTATION_BENEFICIARY_TURN', 'IN_APP', 'PENDING', $3);`,
          [
            row.leader_id,
            `Um membro do grupo "${row.group_name}" esgotou o período de tolerância sem liquidar a quota.`,
            JSON.stringify({ obligation_id: row.obligation_id, defaultedUserId: row.user_id })
          ]
        );

        markedDefaulted += 1;
      }

      return {
        remindersSent,
        markedLate,
        markedDefaulted
      };
    });
  }
}

// Instância singleton do job
const contributionsDueJob = new ContributionsDueJob();

module.exports = contributionsDueJob;