const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para Desembolsos e Rotações de Kixikila.
 * Executa consultas diretas e parametrizadas no Neon PostgreSQL para controle dos turnos
 * de rotação (`rotation_schedules`), atribuições de beneficiários (`beneficiary_assignments`),
 * verificação de fundos acumulados e vinculação contábil no razão.
 */
class PayoutsRepository {
  /**
   * Obtém os detalhes consolidados de um turno de rotação e do beneficiário atribuído,
   * incluindo informações cadastrais do grupo e da carteira digital de destino.
   *
   * @param {string} rotationId - UUID do turno em rotation_schedules
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   */
  async findRotationWithDetails(rotationId, client = null) {
    const text = `
      SELECT 
        rs.id AS rotation_id,
        rs.group_id,
        rs.cycle_number,
        rs.position_order,
        rs.estimated_payout_date,
        rs.actual_payout_date,
        rs.pool_target_amount,
        rs.actual_disbursed_amount,
        rs.currency,
        rs.status,
        rs.schedule_id,
        rs.created_at,
        rs.updated_at,
        g.name AS group_name,
        g.leader_id,
        g.status AS group_status,
        ba.id AS assignment_id,
        ba.beneficiary_user_id,
        ba.assignment_type,
        ba.ledger_payout_id,
        ba.payout_notes,
        p.full_name AS beneficiary_name,
        u.email AS beneficiary_email,
        u.phone_number AS beneficiary_phone,
        w.id AS beneficiary_wallet_id,
        w.status AS beneficiary_wallet_status,
        w.available_balance AS beneficiary_wallet_available_balance
      FROM rotation_schedules rs
      INNER JOIN groups g ON g.id = rs.group_id
      LEFT JOIN beneficiary_assignments ba ON ba.rotation_id = rs.id
      LEFT JOIN users u ON u.id = ba.beneficiary_user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      LEFT JOIN wallets w ON w.user_id = ba.beneficiary_user_id
      WHERE rs.id = $1;
    `;

    return client ? queryOneClient(client, text, [rotationId]) : queryOne(text, [rotationId]);
  }

  /**
   * Consulta o montante total de fundos arrecadados e confirmados na rodada de quotas correspondente.
   *
   * @param {string} scheduleId - UUID da rodada em contribution_schedules
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<bigint>} Total em Kwanzas inteiros (AOA)
   */
  async getPoolCollectedAmount(scheduleId, client = null) {
    const text = `
      SELECT COALESCE(SUM(amount), 0)::bigint AS total_collected
      FROM contributions
      WHERE schedule_id = $1 AND status = 'CONFIRMED';
    `;

    const result = client ? await queryOneClient(client, text, [scheduleId]) : await queryOne(text, [scheduleId]);
    return result ? BigInt(result.total_collected) : 0n;
  }

  /**
   * Atualiza o estado e os valores efetivamente liquidados no turno de rotação.
   *
   * @param {string} rotationId
   * @param {string} status - 'PAID_OUT', 'SKIPPED', 'READY_FOR_PAYOUT', 'CANCELLED'
   * @param {object} [extraParams={}] - { actualPayoutDate, actualDisbursedAmount }
   * @param {import('pg').PoolClient} [client]
   */
  async updateRotationStatus(rotationId, status, extraParams = {}, client = null) {
    const fields = ['status = $1', 'updated_at = NOW() AT TIME ZONE \'UTC\''];
    const values = [status];
    let paramIndex = 2;

    if (status === 'PAID_OUT') {
      fields.push(`actual_payout_date = COALESCE($${paramIndex}, NOW() AT TIME ZONE 'UTC')`);
      values.push(extraParams.actualPayoutDate || new Date());
      paramIndex += 1;

      if (extraParams.actualDisbursedAmount !== undefined) {
        fields.push(`actual_disbursed_amount = $${paramIndex}`);
        values.push(extraParams.actualDisbursedAmount);
        paramIndex += 1;
      }
    }

    values.push(rotationId);
    const text = `
      UPDATE rotation_schedules
      SET ${fields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *;
    `;

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Vincula a transação confirmada do livro-razão contábil à designação do beneficiário da vez.
   *
   * @param {string} assignmentId
   * @param {string} ledgerPayoutId
   * @param {string|null} [notes=null]
   * @param {import('pg').PoolClient} [client]
   */
  async linkLedgerTransactionToAssignment(assignmentId, ledgerPayoutId, notes = null, client = null) {
    const text = `
      UPDATE beneficiary_assignments
      SET ledger_payout_id = $1,
          payout_notes = COALESCE($2, payout_notes),
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $3
      RETURNING id, ledger_payout_id, payout_notes;
    `;

    const values = [ledgerPayoutId, notes, assignmentId];
    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Lista o histórico de desembolsos realizados num grupo de Kixikila com suporte a paginação e filtros.
   *
   * @param {string} groupId
   * @param {object} [filters={}]
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listGroupPayouts(groupId, filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = ['rs.group_id = $1'];
    const values = [groupId];
    let paramIndex = 2;

    if (filters.status) {
      conditions.push(`rs.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex += 1;
    }

    if (filters.cycleNumber) {
      conditions.push(`rs.cycle_number = $${paramIndex}`);
      values.push(filters.cycleNumber);
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    // Contagem total
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM rotation_schedules rs
      WHERE ${whereClause};
    `;
    const countResult = client ? await queryOneClient(client, countSql, values) : await queryOne(countSql, values);
    const totalCount = countResult ? countResult.total : 0;

    // Registos paginados
    values.push(pagination.limit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    values.push(pagination.offset);
    const offsetParam = `$${paramIndex}`;

    const dataSql = `
      SELECT 
        rs.id,
        rs.cycle_number,
        rs.position_order,
        rs.pool_target_amount,
        rs.actual_disbursed_amount,
        rs.currency,
        rs.status,
        rs.estimated_payout_date,
        rs.actual_payout_date,
        p.full_name AS beneficiary_name,
        ba.assignment_type,
        ba.ledger_payout_id
      FROM rotation_schedules rs
      LEFT JOIN beneficiary_assignments ba ON ba.rotation_id = rs.id
      LEFT JOIN users u ON u.id = ba.beneficiary_user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE ${whereClause}
      ORDER BY rs.cycle_number ASC, rs.position_order ASC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }

  /**
   * Lista o histórico de bolos de Kixikila recebidos por determinado utilizador em todos os seus grupos.
   *
   * @param {string} userId
   * @param {object} [filters={}]
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listUserPayouts(userId, filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = ['ba.beneficiary_user_id = $1'];
    const values = [userId];
    let paramIndex = 2;

    if (filters.status) {
      conditions.push(`rs.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM beneficiary_assignments ba
      INNER JOIN rotation_schedules rs ON rs.id = ba.rotation_id
      WHERE ${whereClause};
    `;
    const countResult = client ? await queryOneClient(client, countSql, values) : await queryOne(countSql, values);
    const totalCount = countResult ? countResult.total : 0;

    values.push(pagination.limit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    values.push(pagination.offset);
    const offsetParam = `$${paramIndex}`;

    const dataSql = `
      SELECT 
        rs.id,
        rs.group_id,
        rs.cycle_number,
        rs.position_order,
        rs.pool_target_amount,
        rs.actual_disbursed_amount,
        rs.currency,
        rs.status,
        rs.estimated_payout_date,
        rs.actual_payout_date,
        g.name AS group_name,
        g.slug AS group_slug,
        ba.assignment_type,
        ba.ledger_payout_id
      FROM beneficiary_assignments ba
      INNER JOIN rotation_schedules rs ON rs.id = ba.rotation_id
      INNER JOIN groups g ON g.id = rs.group_id
      WHERE ${whereClause}
      ORDER BY rs.actual_payout_date DESC NULLS LAST, rs.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }
}

// Instância singleton do repositório de payouts
const payoutsRepository = new PayoutsRepository();

module.exports = payoutsRepository;