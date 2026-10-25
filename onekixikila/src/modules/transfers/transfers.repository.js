const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para a tabela `internal_transfers`.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para controle de transferências
 * internas (P2P), apuração de volumes acumulados por utilizador, correlação com o livro-razão
 * e extratos detalhados de envios e recebimentos entre membros da OneKixikila.
 */
class TransfersRepository {
  /**
   * Insere um novo registo de transferência interna direta na tabela internal_transfers.
   *
   * @param {object} params
   * @param {string} params.referenceNumber - Código único de referência (ex: TRF-20261025-ABC123XY)
   * @param {string} params.idempotencyKey - Chave única de idempotência
   * @param {string} params.senderWalletId - UUID da carteira do remetente
   * @param {string} params.senderUserId - UUID do utilizador remetente
   * @param {string} params.recipientWalletId - UUID da carteira do destinatário
   * @param {string} params.recipientUserId - UUID do utilizador destinatário
   * @param {number|bigint} params.amount - Montante transferido em Kwanzas (AOA)
   * @param {number|bigint} [params.feeAmount=0] - Tarifa aplicada
   * @param {string} [params.currency='AOA']
   * @param {string} [params.status='COMPLETED'] - 'PENDING', 'COMPLETED', 'FAILED', 'REVERSED'
   * @param {string|null} [params.description=null]
   * @param {string|null} [params.ledgerTransactionId=null]
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async createTransfer(params, client = null) {
    const {
      referenceNumber,
      idempotencyKey,
      senderWalletId,
      senderUserId,
      recipientWalletId,
      recipientUserId,
      amount,
      feeAmount = 0,
      currency = 'AOA',
      status = 'COMPLETED',
      description = null,
      ledgerTransactionId = null
    } = params;

    const isCompleted = status === 'COMPLETED';
    const text = `
      INSERT INTO internal_transfers (
        reference_number,
        idempotency_key,
        sender_wallet_id,
        sender_user_id,
        recipient_wallet_id,
        recipient_user_id,
        amount,
        fee_amount,
        currency,
        status,
        description,
        ledger_transaction_id,
        completed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *;
    `;

    const values = [
      referenceNumber,
      idempotencyKey,
      senderWalletId,
      senderUserId,
      recipientWalletId,
      recipientUserId,
      amount,
      feeAmount,
      currency,
      status,
      description,
      ledgerTransactionId,
      isCompleted ? new Date() : null
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza uma transferência pelo seu identificador primário UUID,
   * unindo dados cadastrais de remetente e destinatário.
   *
   * @param {string} transferId
   * @param {import('pg').PoolClient} [client]
   */
  async findById(transferId, client = null) {
    const text = `
      SELECT 
        it.id,
        it.reference_number,
        it.idempotency_key,
        it.sender_wallet_id,
        it.sender_user_id,
        it.recipient_wallet_id,
        it.recipient_user_id,
        it.amount,
        it.fee_amount,
        it.currency,
        it.status,
        it.description,
        it.ledger_transaction_id,
        it.completed_at,
        it.created_at,
        it.updated_at,
        su.email AS sender_email,
        su.phone_number AS sender_phone,
        sp.full_name AS sender_name,
        ru.email AS recipient_email,
        ru.phone_number AS recipient_phone,
        rp.full_name AS recipient_name
      FROM internal_transfers it
      INNER JOIN users su ON su.id = it.sender_user_id
      LEFT JOIN user_profiles sp ON sp.user_id = su.id
      INNER JOIN users ru ON ru.id = it.recipient_user_id
      LEFT JOIN user_profiles rp ON rp.user_id = ru.id
      WHERE it.id = $1;
    `;

    return client ? queryOneClient(client, text, [transferId]) : queryOne(text, [transferId]);
  }

  /**
   * Localiza uma transferência pela sua chave de idempotência exclusiva.
   *
   * @param {string} idempotencyKey
   * @param {import('pg').PoolClient} [client]
   */
  async findByIdempotencyKey(idempotencyKey, client = null) {
    const text = `
      SELECT id, reference_number, sender_user_id, recipient_user_id, amount, status, created_at
      FROM internal_transfers
      WHERE idempotency_key = $1;
    `;

    return client ? queryOneClient(client, text, [idempotencyKey]) : queryOne(text, [idempotencyKey]);
  }

  /**
   * Apura o volume total transferido (enviado) por um utilizador no dia atual (UTC)
   * e no mês atual (UTC) para conformidade com os limites prudenciais KYC.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ dailyTransferredAmount: bigint, monthlyTransferredAmount: bigint }>}
   */
  async getUserTransferredVolumes(userId, client = null) {
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
      FROM internal_transfers
      WHERE sender_user_id = $1
        AND status IN ('PENDING', 'COMPLETED');
    `;

    const result = client ? await queryOneClient(client, text, [userId]) : await queryOne(text, [userId]);

    return {
      dailyTransferredAmount: result ? BigInt(result.daily_amount) : 0n,
      monthlyTransferredAmount: result ? BigInt(result.monthly_amount) : 0n
    };
  }

  /**
   * Lista o histórico paginado de transferências enviadas por determinado utilizador.
   *
   * @param {string} userId
   * @param {object} [filters={}]
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listSentTransfers(userId, filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = ['it.sender_user_id = $1'];
    const values = [userId];
    let paramIndex = 2;

    if (filters.status) {
      conditions.push(`it.status = $${paramIndex}`);
      values.push(filters.status.toUpperCase());
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    // 1. Contagem total
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM internal_transfers it
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
        it.id,
        it.reference_number,
        it.amount,
        it.fee_amount,
        it.currency,
        it.status,
        it.description,
        it.completed_at,
        it.created_at,
        ru.email AS recipient_email,
        rp.full_name AS recipient_name
      FROM internal_transfers it
      INNER JOIN users ru ON ru.id = it.recipient_user_id
      LEFT JOIN user_profiles rp ON rp.user_id = ru.id
      WHERE ${whereClause}
      ORDER BY it.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }

  /**
   * Lista o histórico paginado de transferências recebidas por determinado utilizador.
   *
   * @param {string} userId
   * @param {object} [filters={}]
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listReceivedTransfers(userId, filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = ['it.recipient_user_id = $1'];
    const values = [userId];
    let paramIndex = 2;

    if (filters.status) {
      conditions.push(`it.status = $${paramIndex}`);
      values.push(filters.status.toUpperCase());
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM internal_transfers it
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
        it.id,
        it.reference_number,
        it.amount,
        it.fee_amount,
        it.currency,
        it.status,
        it.description,
        it.completed_at,
        it.created_at,
        su.email AS sender_email,
        sp.full_name AS sender_name
      FROM internal_transfers it
      INNER JOIN users su ON su.id = it.sender_user_id
      LEFT JOIN user_profiles sp ON sp.user_id = su.id
      WHERE ${whereClause}
      ORDER BY it.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }
}

// Instância singleton do repositório de transferências
const transfersRepository = new TransfersRepository();

module.exports = transfersRepository;