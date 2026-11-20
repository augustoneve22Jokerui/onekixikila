const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de acesso a dados SQL para as tabelas `contributions` e `contribution_obligations`.
 * Executa operações de persistência e liquidação de quotas de Kixikila no Neon PostgreSQL,
 * vinculando chaves de idempotência, métodos de pagamento e transações do livro-razão contábil.
 */
class ContributionsRepository {
  /**
   * Insere o registo de uma contribuição financeira iniciada ou liquidada.
   *
   * @param {object} params
   * @param {string} params.obligationId - UUID da obrigação de quota
   * @param {string} params.scheduleId - UUID da rodada de calendário
   * @param {string} params.groupId - UUID do grupo de Kixikila
   * @param {string} params.userId - UUID do membro pagador
   * @param {number|bigint} params.amount - Montante da quota em Kwanzas (AOA)
   * @param {number|bigint} [params.feeAmount=0] - Taxas/multas aplicadas
   * @param {number|bigint} params.totalDebited - Total liquidado (amount + feeAmount)
   * @param {string} [params.currency='AOA']
   * @param {string} [params.status='INITIATED'] - 'INITIATED', 'PROCESSING', 'CONFIRMED', 'FAILED'
   * @param {string} params.idempotencyKey - Chave única de proteção contra duplicidade
   * @param {string} [params.paymentMethod='INTERNAL_WALLET']
   * @param {string|null} [params.ledgerTransactionId] - Relacionamento com ledger_transactions
   * @param {Date|null} [params.confirmedAt]
   * @param {string|null} [params.notes]
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async createContribution(params, client = null) {
    const {
      obligationId,
      scheduleId,
      groupId,
      userId,
      amount,
      feeAmount = 0,
      totalDebited,
      currency = 'AOA',
      status = 'INITIATED',
      idempotencyKey,
      paymentMethod = 'INTERNAL_WALLET',
      ledgerTransactionId = null,
      confirmedAt = null,
      notes = null
    } = params;

    const text = `
      INSERT INTO contributions (
        obligation_id,
        schedule_id,
        group_id,
        user_id,
        amount,
        fee_amount,
        total_debited,
        currency,
        status,
        idempotency_key,
        payment_method,
        ledger_transaction_id,
        confirmed_at,
        notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *;
    `;

    const values = [
      obligationId,
      scheduleId,
      groupId,
      userId,
      amount,
      feeAmount,
      totalDebited,
      currency,
      status,
      idempotencyKey,
      paymentMethod,
      ledgerTransactionId,
      confirmedAt,
      notes
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza uma contribuição pelo seu identificador primário UUID, trazendo dados do grupo e pagador.
   *
   * @param {string} contributionId
   * @param {import('pg').PoolClient} [client]
   */
  async findById(contributionId, client = null) {
    const text = `
      SELECT 
        c.id,
        c.obligation_id,
        c.schedule_id,
        c.group_id,
        c.user_id,
        c.amount,
        c.fee_amount,
        c.total_debited,
        c.currency,
        c.status,
        c.idempotency_key,
        c.payment_method,
        c.ledger_transaction_id,
        c.confirmed_at,
        c.notes,
        c.created_at,
        g.name AS group_name,
        g.slug AS group_slug,
        cs.round_number,
        cs.cycle_number,
        p.full_name AS member_name
      FROM contributions c
      INNER JOIN groups g ON g.id = c.group_id
      INNER JOIN contribution_schedules cs ON cs.id = c.schedule_id
      INNER JOIN users u ON u.id = c.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE c.id = $1;
    `;

    return client ? queryOneClient(client, text, [contributionId]) : queryOne(text, [contributionId]);
  }

  /**
   * Localiza uma contribuição pela chave de idempotência exclusiva.
   *
   * @param {string} idempotencyKey
   * @param {import('pg').PoolClient} [client]
   */
  async findByIdempotencyKey(idempotencyKey, client = null) {
    const text = `
      SELECT id, obligation_id, group_id, user_id, amount, status, ledger_transaction_id, confirmed_at, created_at
      FROM contributions
      WHERE idempotency_key = $1;
    `;

    return client ? queryOneClient(client, text, [idempotencyKey]) : queryOne(text, [idempotencyKey]);
  }

  /**
   * Atualiza o estado da contribuição e vincula a transação do livro-razão após confirmação.
   *
   * @param {string} contributionId
   * @param {string} status - 'CONFIRMED', 'FAILED', 'REFUNDED'
   * @param {object} [extraParams={}]
   * @param {import('pg').PoolClient} [client]
   */
  async updateStatus(contributionId, status, extraParams = {}, client = null) {
    const fields = ['status = $1', 'updated_at = NOW() AT TIME ZONE \'UTC\''];
    const values = [status];
    let paramIndex = 2;

    if (status === 'CONFIRMED') {
      fields.push(`confirmed_at = COALESCE($${paramIndex}, NOW() AT TIME ZONE 'UTC')`);
      values.push(extraParams.confirmedAt || new Date());
      paramIndex += 1;
    }

    if (extraParams.ledgerTransactionId) {
      fields.push(`ledger_transaction_id = $${paramIndex}`);
      values.push(extraParams.ledgerTransactionId);
      paramIndex += 1;
    }

    if (extraParams.notes) {
      fields.push(`notes = $${paramIndex}`);
      values.push(extraParams.notes);
      paramIndex += 1;
    }

    values.push(contributionId);
    const text = `
      UPDATE contributions
      SET ${fields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *;
    `;

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Obtém os detalhes completos de uma obrigação financeira de quota, incluindo regras de mora e liderança.
   *
   * @param {string} obligationId
   * @param {import('pg').PoolClient} [client]
   */
  async findObligationWithDetails(obligationId, client = null) {
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
        co.status AS obligation_status,
        co.due_date,
        co.grace_date,
        co.paid_at,
        g.name AS group_name,
        g.leader_id,
        g.status AS group_status,
        g.currency AS group_currency,
        cs.round_number,
        cs.cycle_number,
        cs.status AS schedule_status,
        gr.late_fee_type,
        gr.late_fee_value,
        gm.status AS membership_status,
        gm.is_contribution_restricted,
        w.id AS wallet_id,
        w.available_balance AS wallet_available_balance,
        w.status AS wallet_status
      FROM contribution_obligations co
      INNER JOIN groups g ON g.id = co.group_id
      INNER JOIN contribution_schedules cs ON cs.id = co.schedule_id
      LEFT JOIN group_rules gr ON gr.group_id = g.id
      INNER JOIN group_memberships gm ON gm.id = co.membership_id
      LEFT JOIN wallets w ON w.user_id = co.user_id
      WHERE co.id = $1;
    `;

    return client ? queryOneClient(client, text, [obligationId]) : queryOne(text, [obligationId]);
  }

  /**
   * Quita formalmente a obrigação de contribuição em contribution_obligations.
   *
   * @param {string} obligationId
   * @param {object} params - { paidAmount, lateFee, status, paidAt }
   * @param {import('pg').PoolClient} [client]
   */
  async settleObligation(obligationId, params, client = null) {
    const { paidAmount, lateFee = 0, status = 'PAID', paidAt = new Date() } = params;

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
   * Zera a multa de mora aplicada a uma obrigação (Dispensa/perdão autorizado pela liderança).
   *
   * @param {string} obligationId
   * @param {import('pg').PoolClient} [client]
   */
  async waiveLateFee(obligationId, client = null) {
    const text = `
      UPDATE contribution_obligations
      SET late_fee_assessed = 0,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $1
      RETURNING *;
    `;

    return client ? queryOneClient(client, text, [obligationId]) : queryOne(text, [obligationId]);
  }

  /**
   * Lista as contribuições financeiras efetuadas em determinado grupo com paginação e filtros.
   *
   * @param {string} groupId
   * @param {object} [filters={}]
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listGroupContributions(groupId, filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = ['c.group_id = $1'];
    const values = [groupId];
    let paramIndex = 2;

    if (filters.status) {
      conditions.push(`c.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex += 1;
    }

    if (filters.cycleNumber) {
      conditions.push(`cs.cycle_number = $${paramIndex}`);
      values.push(filters.cycleNumber);
      paramIndex += 1;
    }

    if (filters.roundNumber) {
      conditions.push(`cs.round_number = $${paramIndex}`);
      values.push(filters.roundNumber);
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    // Contagem total
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM contributions c
      INNER JOIN contribution_schedules cs ON cs.id = c.schedule_id
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
        c.id,
        c.amount,
        c.fee_amount,
        c.total_debited,
        c.currency,
        c.status,
        c.payment_method,
        c.confirmed_at,
        c.created_at,
        cs.round_number,
        cs.cycle_number,
        p.full_name AS member_name
      FROM contributions c
      INNER JOIN contribution_schedules cs ON cs.id = c.schedule_id
      INNER JOIN users u ON u.id = c.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE ${whereClause}
      ORDER BY c.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }

  /**
   * Lista o histórico de contribuições pagas por um utilizador em todos os grupos.
   *
   * @param {string} userId
   * @param {object} [filters={}]
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listUserContributions(userId, filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = ['c.user_id = $1'];
    const values = [userId];
    let paramIndex = 2;

    if (filters.status) {
      conditions.push(`c.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM contributions c
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
        c.id,
        c.group_id,
        c.amount,
        c.fee_amount,
        c.total_debited,
        c.currency,
        c.status,
        c.payment_method,
        c.confirmed_at,
        c.created_at,
        g.name AS group_name,
        g.slug AS group_slug,
        cs.round_number
      FROM contributions c
      INNER JOIN groups g ON g.id = c.group_id
      INNER JOIN contribution_schedules cs ON cs.id = c.schedule_id
      WHERE ${whereClause}
      ORDER BY c.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }

  /**
   * Calcula o montante total arrecadado e confirmado em determinada rodada de contribuição.
   *
   * @param {string} scheduleId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<bigint>} Total arrecadado em Kwanzas inteiros
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
}

// Instância singleton do repositório de contribuições
const contributionsRepository = new ContributionsRepository();

module.exports = contributionsRepository;