const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para as tabelas `contribution_schedules` e `contribution_obligations`.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para controlo do calendário de rodadas,
 * datas de vencimento, períodos de carência e obrigações financeiras individuais de cada membro.
 */
class SchedulesRepository {
  /**
   * Cria uma nova rodada no cronograma do grupo de Kixikila.
   *
   * @param {object} params
   * @param {string} params.groupId
   * @param {number} params.cycleNumber
   * @param {number} params.roundNumber
   * @param {Date|string} params.dueDate
   * @param {Date|string} params.gracePeriodEndDate
   * @param {number|bigint} params.expectedAmountPerMember - Valor da quota em Kwanzas (AOA)
   * @param {string} [params.currency='AOA']
   * @param {string} [params.status='SCHEDULED'] - 'SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED'
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async createScheduleRound(params, client = null) {
    const {
      groupId,
      cycleNumber,
      roundNumber,
      dueDate,
      gracePeriodEndDate,
      expectedAmountPerMember,
      currency = 'AOA',
      status = 'SCHEDULED'
    } = params;

    const text = `
      INSERT INTO contribution_schedules (
        group_id,
        cycle_number,
        round_number,
        due_date,
        grace_period_end_date,
        expected_amount_per_member,
        currency,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;

    const values = [
      groupId,
      cycleNumber,
      roundNumber,
      dueDate,
      gracePeriodEndDate,
      expectedAmountPerMember,
      currency,
      status
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Insere em lote as obrigações financeiras de quota para todos os participantes de uma rodada.
   *
   * @param {Array<object>} obligations - Array de objetos contendo scheduleId, groupId, userId, membershipId, etc.
   * @param {import('pg').PoolClient} client - Cliente transacional obrigatório para operações em lote
   * @returns {Promise<Array<object>>}
   */
  async createObligationsBatch(obligations, client) {
    if (!obligations || obligations.length === 0) {
      return [];
    }

    const valueClauses = [];
    const values = [];
    let paramIndex = 1;

    for (const ob of obligations) {
      valueClauses.push(
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, 'PENDING')`
      );
      values.push(
        ob.scheduleId,
        ob.groupId,
        ob.userId,
        ob.membershipId,
        ob.expectedAmount,
        ob.currency || 'AOA',
        ob.dueDate,
        ob.graceDate
      );
      paramIndex += 8;
    }

    const text = `
      INSERT INTO contribution_obligations (
        schedule_id,
        group_id,
        user_id,
        membership_id,
        expected_amount,
        currency,
        due_date,
        grace_date,
        status
      )
      VALUES ${valueClauses.join(', ')}
      ON CONFLICT (schedule_id, user_id) DO NOTHING
      RETURNING *;
    `;

    const result = await queryClient(client, text, values);
    return result.rows;
  }

  /**
   * Localiza uma rodada do calendário pelo seu identificador UUID.
   *
   * @param {string} scheduleId
   * @param {import('pg').PoolClient} [client]
   */
  async findScheduleById(scheduleId, client = null) {
    const text = `
      SELECT 
        cs.id,
        cs.group_id,
        cs.cycle_number,
        cs.round_number,
        cs.due_date,
        cs.grace_period_end_date,
        cs.expected_amount_per_member,
        cs.currency,
        cs.status,
        cs.created_at,
        cs.updated_at,
        g.name AS group_name,
        g.leader_id,
        g.status AS group_status
      FROM contribution_schedules cs
      INNER JOIN groups g ON g.id = cs.group_id
      WHERE cs.id = $1;
    `;

    return client ? queryOneClient(client, text, [scheduleId]) : queryOne(text, [scheduleId]);
  }

  /**
   * Localiza a rodada atual em curso (status ACTIVE) de um grupo de Kixikila.
   *
   * @param {string} groupId
   * @param {import('pg').PoolClient} [client]
   */
  async findCurrentActiveRound(groupId, client = null) {
    const text = `
      SELECT 
        cs.id,
        cs.group_id,
        cs.cycle_number,
        cs.round_number,
        cs.due_date,
        cs.grace_period_end_date,
        cs.expected_amount_per_member,
        cs.currency,
        cs.status,
        (
          SELECT COUNT(*)::integer
          FROM contribution_obligations co
          WHERE co.schedule_id = cs.id AND co.status = 'PAID'
        ) AS paid_obligations_count,
        (
          SELECT COUNT(*)::integer
          FROM contribution_obligations co
          WHERE co.schedule_id = cs.id
        ) AS total_obligations_count
      FROM contribution_schedules cs
      WHERE cs.group_id = $1 AND cs.status = 'ACTIVE'
      LIMIT 1;
    `;

    return client ? queryOneClient(client, text, [groupId]) : queryOne(text, [groupId]);
  }

  /**
   * Lista todas as rodadas do cronograma de um grupo, ordenadas por ciclo e número de rodada.
   *
   * @param {string} groupId
   * @param {number|null} [cycleNumber]
   * @param {import('pg').PoolClient} [client]
   */
  async listSchedulesByGroup(groupId, cycleNumber = null, client = null) {
    const conditions = ['cs.group_id = $1'];
    const values = [groupId];

    if (cycleNumber !== null && cycleNumber !== undefined) {
      conditions.push('cs.cycle_number = $2');
      values.push(cycleNumber);
    }

    const text = `
      SELECT 
        cs.id,
        cs.group_id,
        cs.cycle_number,
        cs.round_number,
        cs.due_date,
        cs.grace_period_end_date,
        cs.expected_amount_per_member,
        cs.currency,
        cs.status,
        (
          SELECT COUNT(*)::integer
          FROM contribution_obligations co
          WHERE co.schedule_id = cs.id AND co.status = 'PAID'
        ) AS paid_obligations_count,
        (
          SELECT COUNT(*)::integer
          FROM contribution_obligations co
          WHERE co.schedule_id = cs.id
        ) AS total_obligations_count
      FROM contribution_schedules cs
      WHERE ${conditions.join(' AND ')}
      ORDER BY cs.cycle_number ASC, cs.round_number ASC;
    `;

    const result = client ? await queryClient(client, text, values) : await query(text, values);
    return result.rows;
  }

  /**
   * Atualiza o estado operacional de uma rodada de calendário (ex: SCHEDULED -> ACTIVE -> COMPLETED).
   *
   * @param {string} scheduleId
   * @param {string} status - 'SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED'
   * @param {import('pg').PoolClient} [client]
   */
  async updateScheduleStatus(scheduleId, status, client = null) {
    const text = `
      UPDATE contribution_schedules
      SET status = $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2
      RETURNING *;
    `;

    return client ? queryOneClient(client, text, [status, scheduleId]) : queryOne(text, [status, scheduleId]);
  }

  /**
   * Lista todas as obrigações individuais exigíveis em determinada rodada com identificação dos membros.
   *
   * @param {string} scheduleId
   * @param {import('pg').PoolClient} [client]
   */
  async getObligationsBySchedule(scheduleId, client = null) {
    const text = `
      SELECT 
        co.id AS obligation_id,
        co.schedule_id,
        co.group_id,
        co.user_id,
        co.membership_id,
        co.expected_amount,
        co.paid_amount,
        co.late_fee_assessed,
        co.currency,
        co.status,
        co.due_date,
        co.grace_date,
        co.paid_at,
        p.full_name,
        p.preferred_name,
        p.avatar_url,
        gm.slot_number
      FROM contribution_obligations co
      INNER JOIN users u ON u.id = co.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      LEFT JOIN group_memberships gm ON gm.id = co.membership_id
      WHERE co.schedule_id = $1
      ORDER BY gm.slot_number ASC, co.created_at ASC;
    `;

    const result = client ? await queryClient(client, text, [scheduleId]) : await query(text, [scheduleId]);
    return result.rows;
  }

  /**
   * Localiza uma obrigação individual pelo seu identificador primário UUID.
   *
   * @param {string} obligationId
   * @param {import('pg').PoolClient} [client]
   */
  async findObligationById(obligationId, client = null) {
    const text = `
      SELECT 
        co.id,
        co.schedule_id,
        co.group_id,
        co.user_id,
        co.membership_id,
        co.expected_amount,
        co.paid_amount,
        co.late_fee_assessed,
        co.currency,
        co.status,
        co.due_date,
        co.grace_date,
        co.paid_at,
        g.name AS group_name,
        cs.round_number,
        cs.cycle_number
      FROM contribution_obligations co
      INNER JOIN groups g ON g.id = co.group_id
      INNER JOIN contribution_schedules cs ON cs.id = co.schedule_id
      WHERE co.id = $1;
    `;

    return client ? queryOneClient(client, text, [obligationId]) : queryOne(text, [obligationId]);
  }

  /**
   * Consulta a obrigação exigível de determinado utilizador em uma rodada específica.
   *
   * @param {string} scheduleId
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   */
  async findUserObligation(scheduleId, userId, client = null) {
    const text = `
      SELECT 
        id,
        schedule_id,
        group_id,
        user_id,
        membership_id,
        expected_amount,
        paid_amount,
        late_fee_assessed,
        currency,
        status,
        due_date,
        grace_date,
        paid_at
      FROM contribution_obligations
      WHERE schedule_id = $1 AND user_id = $2;
    `;

    return client ? queryOneClient(client, text, [scheduleId, userId]) : queryOne(text, [scheduleId, userId]);
  }

  /**
   * Atualiza a obrigação registando a quitação da quota de contribuição e eventual multa de mora.
   *
   * @param {object} params
   * @param {string} params.obligationId
   * @param {number|bigint} params.paidAmount
   * @param {number|bigint} [params.lateFee=0]
   * @param {string} [params.status='PAID']
   * @param {Date} [params.paidAt]
   * @param {import('pg').PoolClient} [client]
   */
  async updateObligationPayment(params, client = null) {
    const {
      obligationId,
      paidAmount,
      lateFee = 0,
      status = 'PAID',
      paidAt = new Date()
    } = params;

    const text = `
      UPDATE contribution_obligations
      SET paid_amount = $1,
          late_fee_assessed = $2,
          status = $3,
          paid_at = $4,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $5
      RETURNING *;
    `;

    const values = [paidAmount, lateFee, status, paidAt, obligationId];
    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Conta a quantidade de quotas que ainda não foram liquidadas em determinada rodada.
   *
   * @param {string} scheduleId
   * @param {import('pg').PoolClient} [client]
   */
  async countPendingObligations(scheduleId, client = null) {
    const text = `
      SELECT COUNT(*)::integer AS pending_count
      FROM contribution_obligations
      WHERE schedule_id = $1 AND status IN ('PENDING', 'LATE', 'DEFAULTED');
    `;

    const result = client ? await queryOneClient(client, text, [scheduleId]) : await queryOne(text, [scheduleId]);
    return result ? result.pending_count : 0;
  }

  /**
   * Lista as quotas e obrigações a vencer de um utilizador em todos os grupos a que pertence.
   *
   * @param {string} userId
   * @param {number} [limit=10]
   * @param {import('pg').PoolClient} [client]
   */
  async listUserUpcomingObligations(userId, limit = 10, client = null) {
    const text = `
      SELECT 
        co.id AS obligation_id,
        co.group_id,
        co.expected_amount,
        co.currency,
        co.status,
        co.due_date,
        co.grace_date,
        g.name AS group_name,
        g.slug AS group_slug,
        cs.round_number
      FROM contribution_obligations co
      INNER JOIN groups g ON g.id = co.group_id
      INNER JOIN contribution_schedules cs ON cs.id = co.schedule_id
      WHERE co.user_id = $1
        AND co.status IN ('PENDING', 'LATE')
      ORDER BY co.due_date ASC
      LIMIT $2;
    `;

    const result = client ? await queryClient(client, text, [userId, limit]) : await query(text, [userId, limit]);
    return result.rows;
  }
}

// Instância singleton do repositório de calendários
const schedulesRepository = new SchedulesRepository();

module.exports = schedulesRepository;