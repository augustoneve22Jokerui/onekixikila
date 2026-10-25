const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para a tabela `withdrawals`.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para controle de ordens
 * de levantamento de fundos, apuração de volumes cumulativos de saídas por utilizador,
 * conciliação com o livro-razão e relatórios de tesouraria.
 */
class WithdrawalsRepository {
  /**
   * Insere um novo pedido de levantamento na tabela withdrawals.
   *
   * @param {object} params
   * @param {string} params.walletId - UUID da carteira do utilizador
   * @param {string} params.userId - UUID do utilizador solicitante
   * @param {string} params.referenceNumber - Código único de referência (ex: WTH-20261024-ABC123XY)
   * @param {string} params.idempotencyKey - Chave única de idempotência
   * @param {number|bigint} params.amount - Montante líquido a ser enviado ao beneficiário em Kwanzas
   * @param {number|bigint} [params.feeAmount=0] - Tarifa administrativa aplicada
   * @param {number|bigint} params.totalDebited - Total a debitar da carteira (amount + feeAmount)
   * @param {string} [params.currency='AOA']
   * @param {string} params.destinationType - 'BANK_ACCOUNT_IBAN', 'MULTICAIXA_EXPRESS_PHONE', 'UNITEL_MONEY_PHONE', 'E_KWANZA_PHONE'
   * @param {string} params.destinationAccount - IBAN ou número de telemóvel associado
   * @param {string} params.destinationHolderName - Nome do titular da conta de destino
   * @param {string} params.provider - Prestador de pagamento ou rede bancária
   * @param {string} [params.status='REQUESTED'] - 'REQUESTED', 'APPROVED', 'PROCESSING', etc.
   * @param {object} [params.metadata={}]
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async createWithdrawal(params, client = null) {
    const {
      walletId,
      userId,
      referenceNumber,
      idempotencyKey,
      amount,
      feeAmount = 0,
      totalDebited,
      currency = 'AOA',
      destinationType,
      destinationAccount,
      destinationHolderName,
      provider,
      status = 'REQUESTED',
      metadata = {}
    } = params;

    const text = `
      INSERT INTO withdrawals (
        wallet_id,
        user_id,
        reference_number,
        idempotency_key,
        amount,
        fee_amount,
        total_debited,
        currency,
        destination_type,
        destination_account,
        destination_holder_name,
        provider,
        status,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
      RETURNING *;
    `;

    const values = [
      walletId,
      userId,
      referenceNumber,
      idempotencyKey,
      amount,
      feeAmount,
      totalDebited,
      currency,
      destinationType,
      destinationAccount,
      destinationHolderName,
      provider.toUpperCase(),
      status,
      JSON.stringify(metadata)
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza um levantamento pelo seu identificador primário UUID unindo dados da conta e carteira.
   *
   * @param {string} withdrawalId
   * @param {import('pg').PoolClient} [client]
   */
  async findById(withdrawalId, client = null) {
    const text = `
      SELECT 
        wth.id,
        wth.wallet_id,
        wth.user_id,
        wth.reference_number,
        wth.idempotency_key,
        wth.amount,
        wth.fee_amount,
        wth.total_debited,
        wth.currency,
        wth.destination_type,
        wth.destination_account,
        wth.destination_holder_name,
        wth.provider,
        wth.provider_reference,
        wth.status,
        wth.reviewed_by,
        wth.reviewed_at,
        wth.settled_at,
        wth.failure_reason,
        wth.ledger_transaction_id,
        wth.metadata,
        wth.created_at,
        wth.updated_at,
        u.email,
        u.phone_number,
        p.full_name AS user_registered_name,
        w.available_balance AS wallet_available_balance,
        w.locked_balance AS wallet_locked_balance,
        w.ledger_balance AS wallet_ledger_balance
      FROM withdrawals wth
      INNER JOIN users u ON u.id = wth.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      INNER JOIN wallets w ON w.id = wth.wallet_id
      WHERE wth.id = $1;
    `;

    return client ? queryOneClient(client, text, [withdrawalId]) : queryOne(text, [withdrawalId]);
  }

  /**
   * Localiza um pedido de levantamento pela chave de idempotência exclusiva.
   *
   * @param {string} idempotencyKey
   * @param {import('pg').PoolClient} [client]
   */
  async findByIdempotencyKey(idempotencyKey, client = null) {
    const text = `
      SELECT id, wallet_id, user_id, reference_number, amount, total_debited, status, created_at
      FROM withdrawals
      WHERE idempotency_key = $1;
    `;

    return client ? queryOneClient(client, text, [idempotencyKey]) : queryOne(text, [idempotencyKey]);
  }

  /**
   * Atualiza o estado operacional e os marcos temporais da ordem de levantamento.
   *
   * @param {string} withdrawalId
   * @param {string} status - 'APPROVED', 'PROCESSING', 'SETTLED', 'REJECTED', 'CANCELLED'
   * @param {object} [extraParams={}] - { reviewedBy, failureReason, settledAt, ledgerTransactionId }
   * @param {import('pg').PoolClient} [client]
   */
  async updateStatus(withdrawalId, status, extraParams = {}, client = null) {
    const fields = ['status = $1', 'updated_at = NOW() AT TIME ZONE \'UTC\''];
    const values = [status];
    let paramIndex = 2;

    if (extraParams.reviewedBy) {
      fields.push(`reviewed_by = $${paramIndex}`);
      fields.push(`reviewed_at = NOW() AT TIME ZONE 'UTC'`);
      values.push(extraParams.reviewedBy);
      paramIndex += 1;
    }

    if (extraParams.failureReason) {
      fields.push(`failure_reason = $${paramIndex}`);
      values.push(extraParams.failureReason);
      paramIndex += 1;
    }

    if (status === 'SETTLED') {
      fields.push(`settled_at = COALESCE($${paramIndex}, NOW() AT TIME ZONE 'UTC')`);
      values.push(extraParams.settledAt || new Date());
      paramIndex += 1;
    }

    if (extraParams.ledgerTransactionId) {
      fields.push(`ledger_transaction_id = $${paramIndex}`);
      values.push(extraParams.ledgerTransactionId);
      paramIndex += 1;
    }

    values.push(withdrawalId);
    const text = `
      UPDATE withdrawals
      SET ${fields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *;
    `;

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Calcula o volume cumulativo financeiro levantado por um utilizador no dia atual (UTC)
   * e no mês atual (UTC) para verificação dos limites de conformidade prudencial KYC.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ dailyWithdrawnAmount: bigint, monthlyWithdrawnAmount: bigint }>}
   */
  async getUserWithdrawnVolumes(userId, client = null) {
    const text = `
      SELECT 
        COALESCE(
          SUM(
            CASE 
              WHEN created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') 
              THEN amount 
              ELSE 0 
            END
          ), 0
        )::bigint AS daily_amount,
        COALESCE(
          SUM(
            CASE 
              WHEN created_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC') 
              THEN amount 
              ELSE 0 
            END
          ), 0
        )::bigint AS monthly_amount
      FROM withdrawals
      WHERE user_id = $1
        AND status IN ('REQUESTED', 'APPROVED', 'PROCESSING', 'SETTLED');
    `;

    const result = client ? await queryOneClient(client, text, [userId]) : await queryOne(text, [userId]);

    return {
      dailyWithdrawnAmount: result ? BigInt(result.daily_amount) : 0n,
      monthlyWithdrawnAmount: result ? BigInt(result.monthly_amount) : 0n
    };
  }

  /**
   * Lista o histórico de levantamentos solicitados por um utilizador com suporte a filtros e paginação.
   *
   * @param {string} userId
   * @param {object} [filters={}]
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listUserWithdrawals(userId, filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = ['wth.user_id = $1'];
    const values = [userId];
    let paramIndex = 2;

    if (filters.status) {
      conditions.push(`wth.status = $${paramIndex}`);
      values.push(filters.status.toUpperCase());
      paramIndex += 1;
    }

    if (filters.destinationType) {
      conditions.push(`wth.destination_type = $${paramIndex}`);
      values.push(filters.destinationType);
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    // 1. Contagem total
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM withdrawals wth
      WHERE ${whereClause};
    `;
    const countResult = client ? await queryOneClient(client, countSql, values) : await queryOne(countSql, values);
    const totalCount = countResult ? countResult.total : 0;

    // 2. Registos paginados
    values.push(pagination.limit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    values.push(pagination.offset);
    const offsetParam = `$${paramIndex}`;

    const dataSql = `
      SELECT 
        wth.id,
        wth.reference_number,
        wth.amount,
        wth.fee_amount,
        wth.total_debited,
        wth.currency,
        wth.destination_type,
        wth.destination_account,
        wth.destination_holder_name,
        wth.provider,
        wth.status,
        wth.settled_at,
        wth.failure_reason,
        wth.created_at
      FROM withdrawals wth
      WHERE ${whereClause}
      ORDER BY wth.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }

  /**
   * Lista a fila geral de levantamentos da plataforma para supervisão de tesouraria e conciliação bancária.
   *
   * @param {object} [filters={}]
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listAllWithdrawals(filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (filters.status) {
      conditions.push(`wth.status = $${paramIndex}`);
      values.push(filters.status.toUpperCase());
      paramIndex += 1;
    }

    if (filters.provider) {
      conditions.push(`wth.provider = $${paramIndex}`);
      values.push(filters.provider.toUpperCase());
      paramIndex += 1;
    }

    if (filters.destinationType) {
      conditions.push(`wth.destination_type = $${paramIndex}`);
      values.push(filters.destinationType);
      paramIndex += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM withdrawals wth
      ${whereClause};
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
        wth.id,
        wth.reference_number,
        wth.user_id,
        wth.amount,
        wth.fee_amount,
        wth.total_debited,
        wth.currency,
        wth.destination_type,
        wth.destination_account,
        wth.destination_holder_name,
        wth.provider,
        wth.status,
        wth.reviewed_by,
        wth.settled_at,
        wth.created_at,
        u.email,
        u.phone_number,
        p.full_name AS user_registered_name
      FROM withdrawals wth
      INNER JOIN users u ON u.id = wth.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      ${whereClause}
      ORDER BY wth.created_at ASC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }
}

// Instância singleton do repositório de levantamentos
const withdrawalsRepository = new WithdrawalsRepository();

module.exports = withdrawalsRepository;