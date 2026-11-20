const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para a tabela `payment_requests`.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para registo de intenções de pagamento,
 * correlação com depósitos/quotas, atualização de referências externas dos gateways e histórico de checkout.
 */
class PaymentsRepository {
  /**
   * Insere um novo pedido de pagamento na tabela payment_requests.
   *
   * @param {object} params
   * @param {string} params.userId - UUID do utilizador pagador
   * @param {string} params.walletId - UUID da carteira do utilizador
   * @param {string|null} [params.groupId=null] - UUID do grupo (se quota)
   * @param {string|null} [params.depositId=null] - UUID do depósito relacionado
   * @param {string|null} [params.contributionId=null] - UUID da contribuição relacionada
   * @param {string} params.merchantReference - Referência única da OneKixikila
   * @param {string|null} [params.providerTransactionId=null] - ID retornado pelo prestador
   * @param {string} params.provider - 'MULTICAIXA_EXPRESS', 'UNITEL_MONEY', 'E_KWANZA'
   * @param {string} [params.channel='MOBILE'] - 'MOBILE', 'QR_CODE', 'USSD', 'WEB'
   * @param {number|bigint} params.amount - Montante em Kwanzas inteiros (AOA)
   * @param {string} [params.currency='AOA']
   * @param {string|null} [params.phoneNumber=null]
   * @param {string} [params.status='PENDING'] - 'PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', etc.
   * @param {string|null} [params.qrPayload=null]
   * @param {Date} params.expiresAt
   * @param {object} [params.metadata={}]
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async createPaymentRequest(params, client = null) {
    const {
      userId,
      walletId,
      groupId = null,
      depositId = null,
      contributionId = null,
      merchantReference,
      providerTransactionId = null,
      provider,
      channel = 'MOBILE',
      amount,
      currency = 'AOA',
      phoneNumber = null,
      status = 'PENDING',
      qrPayload = null,
      expiresAt,
      metadata = {}
    } = params;

    const text = `
      INSERT INTO payment_requests (
        user_id,
        wallet_id,
        group_id,
        deposit_id,
        contribution_id,
        merchant_reference,
        provider_transaction_id,
        provider,
        channel,
        amount,
        currency,
        phone_number,
        status,
        qr_payload,
        expires_at,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
      RETURNING *;
    `;

    const values = [
      userId,
      walletId,
      groupId,
      depositId,
      contributionId,
      merchantReference,
      providerTransactionId,
      provider.toUpperCase(),
      channel.toUpperCase(),
      amount,
      currency,
      phoneNumber,
      status,
      qrPayload,
      expiresAt,
      JSON.stringify(metadata)
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza um pedido de pagamento pelo seu identificador primário UUID.
   *
   * @param {string} paymentId
   * @param {import('pg').PoolClient} [client]
   */
  async findById(paymentId, client = null) {
    const text = `
      SELECT 
        pr.id,
        pr.user_id,
        pr.wallet_id,
        pr.group_id,
        pr.deposit_id,
        pr.contribution_id,
        pr.merchant_reference,
        pr.provider_transaction_id,
        pr.provider,
        pr.channel,
        pr.amount,
        pr.currency,
        pr.phone_number,
        pr.status,
        pr.qr_payload,
        pr.expires_at,
        pr.paid_at,
        pr.metadata,
        pr.created_at,
        pr.updated_at,
        u.email,
        p.full_name AS user_name,
        g.name AS group_name
      FROM payment_requests pr
      INNER JOIN users u ON u.id = pr.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      LEFT JOIN groups g ON g.id = pr.group_id
      WHERE pr.id = $1;
    `;

    return client ? queryOneClient(client, text, [paymentId]) : queryOne(text, [paymentId]);
  }

  /**
   * Localiza uma ordem de pagamento pela referência comercial única da OneKixikila.
   *
   * @param {string} merchantReference
   * @param {import('pg').PoolClient} [client]
   */
  async findByMerchantReference(merchantReference, client = null) {
    const text = `
      SELECT 
        pr.id,
        pr.user_id,
        pr.wallet_id,
        pr.group_id,
        pr.deposit_id,
        pr.contribution_id,
        pr.merchant_reference,
        pr.provider_transaction_id,
        pr.provider,
        pr.channel,
        pr.amount,
        pr.currency,
        pr.phone_number,
        pr.status,
        pr.qr_payload,
        pr.expires_at,
        pr.paid_at,
        pr.created_at
      FROM payment_requests pr
      WHERE pr.merchant_reference = $1;
    `;

    return client ? queryOneClient(client, text, [merchantReference]) : queryOne(text, [merchantReference]);
  }

  /**
   * Atualiza o estado da ordem de pagamento e vincula o ID externo do prestador.
   *
   * @param {string} paymentId
   * @param {string} status - 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED'
   * @param {object} [extraFields={}] - { providerTransactionId, paidAt }
   * @param {import('pg').PoolClient} [client]
   */
  async updateStatus(paymentId, status, extraFields = {}, client = null) {
    const fields = ['status = $1', 'updated_at = NOW() AT TIME ZONE \'UTC\''];
    const values = [status];
    let paramIndex = 2;

    if (extraFields.providerTransactionId) {
      fields.push(`provider_transaction_id = $${paramIndex}`);
      values.push(extraFields.providerTransactionId);
      paramIndex += 1;
    }

    if (status === 'SUCCEEDED') {
      fields.push(`paid_at = COALESCE($${paramIndex}, NOW() AT TIME ZONE 'UTC')`);
      values.push(extraFields.paidAt || new Date());
      paramIndex += 1;
    }

    values.push(paymentId);
    const text = `
      UPDATE payment_requests
      SET ${fields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *;
    `;

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Lista as ordens de pagamento de um utilizador com filtros e paginação.
   *
   * @param {string} userId
   * @param {object} [filters={}]
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listUserPaymentRequests(userId, filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = ['pr.user_id = $1'];
    const values = [userId];
    let paramIndex = 2;

    if (filters.status) {
      conditions.push(`pr.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex += 1;
    }

    if (filters.provider) {
      conditions.push(`pr.provider = $${paramIndex}`);
      values.push(filters.provider.toUpperCase());
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    // Contagem total
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM payment_requests pr
      WHERE ${whereClause};
    `;
    const countResult = client ? await queryOneClient(client, countSql, values) : await queryOne(countSql, values);
    const totalCount = countResult ? countResult.total : 0;

    // Linhas paginadas
    values.push(pagination.limit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    values.push(pagination.offset);
    const offsetParam = `$${paramIndex}`;

    const dataSql = `
      SELECT 
        pr.id,
        pr.merchant_reference,
        pr.provider_transaction_id,
        pr.provider,
        pr.channel,
        pr.amount,
        pr.currency,
        pr.status,
        pr.expires_at,
        pr.paid_at,
        pr.created_at
      FROM payment_requests pr
      WHERE ${whereClause}
      ORDER BY pr.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }
}

// Instância singleton do repositório de pagamentos
const paymentsRepository = new PaymentsRepository();

module.exports = paymentsRepository;