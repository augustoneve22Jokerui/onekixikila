const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para a tabela `deposits`.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para criação de intenções de depósito,
 * apuração de limites cumulativos (diários e mensais), transições de estado e conciliação contábil com livro-razão.
 */
class DepositsRepository {
  /**
   * Insere o registo de uma intenção de depósito na tabela deposits.
   *
   * @param {object} params
   * @param {string} params.walletId - UUID da carteira do utilizador
   * @param {string} params.userId - UUID do utilizador depositante
   * @param {string} params.referenceNumber - Código único da transação (ex: DEP-20261024-ABC123XY)
   * @param {string} params.idempotencyKey - Chave única de idempotência
   * @param {number|bigint} params.amount - Valor bruto em Kwanzas inteiros (AOA)
   * @param {number|bigint} [params.feeAmount=0] - Taxa administrativa aplicada
   * @param {number|bigint} params.netAmount - Valor líquido a creditar (amount - feeAmount)
   * @param {string} [params.currency='AOA']
   * @param {string} params.provider - 'MULTICAIXA_EXPRESS', 'UNITEL_MONEY', 'E_KWANZA'
   * @param {string|null} [params.providerReference] - Referência externa emitida pelo gateway
   * @param {string} [params.status='CREATED'] - 'CREATED', 'PENDING_PAYMENT', etc.
   * @param {Date} params.expiresAt - Data limite de validade para pagamento
   * @param {object} [params.metadata={}]
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async createDeposit(params, client = null) {
    const {
      walletId,
      userId,
      referenceNumber,
      idempotencyKey,
      amount,
      feeAmount = 0,
      netAmount,
      currency = 'AOA',
      provider,
      providerReference = null,
      status = 'CREATED',
      expiresAt,
      metadata = {}
    } = params;

    const text = `
      INSERT INTO deposits (
        wallet_id,
        user_id,
        reference_number,
        idempotency_key,
        amount,
        fee_amount,
        net_amount,
        currency,
        provider,
        provider_reference,
        status,
        expires_at,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
      RETURNING *;
    `;

    const values = [
      walletId,
      userId,
      referenceNumber,
      idempotencyKey,
      amount,
      feeAmount,
      netAmount,
      currency,
      provider.toUpperCase(),
      providerReference,
      status,
      expiresAt,
      JSON.stringify(metadata)
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza um depósito pelo seu identificador primário UUID, trazendo dados do titular.
   *
   * @param {string} depositId
   * @param {import('pg').PoolClient} [client]
   */
  async findById(depositId, client = null) {
    const text = `
      SELECT 
        d.id,
        d.wallet_id,
        d.user_id,
        d.reference_number,
        d.idempotency_key,
        d.amount,
        d.fee_amount,
        d.net_amount,
        d.currency,
        d.provider,
        d.provider_reference,
        d.status,
        d.expires_at,
        d.confirmed_at,
        d.settled_at,
        d.ledger_transaction_id,
        d.metadata,
        d.created_at,
        d.updated_at,
        u.email,
        u.phone_number,
        p.full_name AS user_name,
        w.available_balance AS wallet_available_balance,
        w.ledger_balance AS wallet_ledger_balance
      FROM deposits d
      INNER JOIN users u ON u.id = d.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      INNER JOIN wallets w ON w.id = d.wallet_id
      WHERE d.id = $1;
    `;

    return client ? queryOneClient(client, text, [depositId]) : queryOne(text, [depositId]);
  }

  /**
   * Localiza um depósito pelo seu código de referência comercial único.
   *
   * @param {string} referenceNumber
   * @param {import('pg').PoolClient} [client]
   */
  async findByReferenceNumber(referenceNumber, client = null) {
    const text = `
      SELECT 
        d.id,
        d.wallet_id,
        d.user_id,
        d.reference_number,
        d.idempotency_key,
        d.amount,
        d.fee_amount,
        d.net_amount,
        d.currency,
        d.provider,
        d.provider_reference,
        d.status,
        d.expires_at,
        d.confirmed_at,
        d.settled_at,
        d.ledger_transaction_id,
        d.created_at
      FROM deposits d
      WHERE d.reference_number = $1;
    `;

    return client ? queryOneClient(client, text, [referenceNumber]) : queryOne(text, [referenceNumber]);
  }

  /**
   * Localiza um depósito pela sua chave de idempotência exclusiva.
   *
   * @param {string} idempotencyKey
   * @param {import('pg').PoolClient} [client]
   */
  async findByIdempotencyKey(idempotencyKey, client = null) {
    const text = `
      SELECT id, wallet_id, user_id, reference_number, amount, status, ledger_transaction_id, created_at
      FROM deposits
      WHERE idempotency_key = $1;
    `;

    return client ? queryOneClient(client, text, [idempotencyKey]) : queryOne(text, [idempotencyKey]);
  }

  /**
   * Atualiza o estado e os marcos temporais de um depósito.
   *
   * @param {string} depositId
   * @param {string} status - 'PENDING_PAYMENT', 'CONFIRMED', 'SETTLED', 'FAILED', 'EXPIRED', 'CANCELLED'
   * @param {object} [extraParams={}] - { providerReference, confirmedAt, settledAt, ledgerTransactionId }
   * @param {import('pg').PoolClient} [client]
   */
  async updateStatus(depositId, status, extraParams = {}, client = null) {
    const fields = ['status = $1', 'updated_at = NOW() AT TIME ZONE \'UTC\''];
    const values = [status];
    let paramIndex = 2;

    if (extraParams.providerReference) {
      fields.push(`provider_reference = $${paramIndex}`);
      values.push(extraParams.providerReference);
      paramIndex += 1;
    }

    if (status === 'CONFIRMED' || status === 'SETTLED') {
      fields.push(`confirmed_at = COALESCE($${paramIndex}, NOW() AT TIME ZONE 'UTC')`);
      values.push(extraParams.confirmedAt || new Date());
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

    values.push(depositId);
    const text = `
      UPDATE deposits
      SET ${fields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *;
    `;

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Calcula o volume financeiro acumulado de depósitos confirmados/liquidados por um utilizador
   * no dia atual (UTC) e no mês atual (UTC) para apuração de limites operacionais KYC.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ dailyDepositedAmount: bigint, monthlyDepositedAmount: bigint }>}
   */
  async getUserDepositedVolumes(userId, client = null) {
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
      FROM deposits
      WHERE user_id = $1
        AND status IN ('CONFIRMED', 'SETTLED', 'PROCESSING', 'PENDING_PAYMENT');
    `;

    const result = client ? await queryOneClient(client, text, [userId]) : await queryOne(text, [userId]);

    return {
      dailyDepositedAmount: result ? BigInt(result.daily_amount) : 0n,
      monthlyDepositedAmount: result ? BigInt(result.monthly_amount) : 0n
    };
  }

  /**
   * Lista o histórico de depósitos de um utilizador com suporte a filtros e paginação.
   *
   * @param {string} userId
   * @param {object} [filters={}]
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listUserDeposits(userId, filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = ['d.user_id = $1'];
    const values = [userId];
    let paramIndex = 2;

    if (filters.status) {
      conditions.push(`d.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex += 1;
    }

    if (filters.provider) {
      conditions.push(`d.provider = $${paramIndex}`);
      values.push(filters.provider.toUpperCase());
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    // Contagem total
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM deposits d
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
        d.id,
        d.reference_number,
        d.amount,
        d.fee_amount,
        d.net_amount,
        d.currency,
        d.provider,
        d.status,
        d.expires_at,
        d.confirmed_at,
        d.settled_at,
        d.created_at
      FROM deposits d
      WHERE ${whereClause}
      ORDER BY d.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }
}

// Instância singleton do repositório de depósitos
const depositsRepository = new DepositsRepository();

module.exports = depositsRepository;