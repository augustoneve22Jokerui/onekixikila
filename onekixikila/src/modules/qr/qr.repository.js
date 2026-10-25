const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de acesso a dados SQL para a tabela `qr_tokens`.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para emissão de Códigos QR,
 * validação atômica de cotas de escaneamento (`scan_count <= max_scans`), resolução de tokens
 * e revogação imediata.
 */
class QrRepository {
  /**
   * Insere um novo token QR na tabela qr_tokens.
   *
   * @param {object} params
   * @param {string} params.tokenCode - Código alfanumérico único do QR
   * @param {string} params.qrType - 'GROUP_INVITE', 'PAYMENT_RECEIVE', 'DIRECT_TRANSFER', 'DEVICE_LINK'
   * @param {string} params.creatorUserId - UUID do utilizador emissor
   * @param {string|null} [params.targetGroupId=null] - UUID do grupo (se convite)
   * @param {string|null} [params.targetWalletId=null] - UUID da carteira (se pagamento)
   * @param {string|null} [params.paymentRequestId=null] - UUID do pedido de pagamento relacionado
   * @param {number|bigint|null} [params.fixedAmount=null] - Montante pré-fixado em Kwanzas (se aplicável)
   * @param {string} [params.currency='AOA']
   * @param {number} [params.maxScans=1] - Limite de leituras/consumos autorizados
   * @param {Date} params.expiresAt - Data/hora limite de expiração
   * @param {object} [params.metadata={}]
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async createQrToken(params, client = null) {
    const {
      tokenCode,
      qrType,
      creatorUserId,
      targetGroupId = null,
      targetWalletId = null,
      paymentRequestId = null,
      fixedAmount = null,
      currency = 'AOA',
      maxScans = 1,
      expiresAt,
      metadata = {}
    } = params;

    const text = `
      INSERT INTO qr_tokens (
        token_code,
        qr_type,
        status,
        creator_user_id,
        target_group_id,
        target_wallet_id,
        payment_request_id,
        fixed_amount,
        currency,
        max_scans,
        scan_count,
        expires_at,
        metadata
      )
      VALUES ($1, $2, 'ACTIVE', $3, $4, $5, $6, $7, $8, $9, 0, $10, $11::jsonb)
      RETURNING *;
    `;

    const values = [
      tokenCode,
      qrType,
      creatorUserId,
      targetGroupId,
      targetWalletId,
      paymentRequestId,
      fixedAmount,
      currency,
      maxScans,
      expiresAt,
      JSON.stringify(metadata)
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza um token QR pelo seu identificador primário UUID.
   *
   * @param {string} qrTokenId
   * @param {import('pg').PoolClient} [client]
   */
  async findById(qrTokenId, client = null) {
    const text = `
      SELECT 
        qt.id,
        qt.token_code,
        qt.qr_type,
        qt.status,
        qt.creator_user_id,
        qt.target_group_id,
        qt.target_wallet_id,
        qt.payment_request_id,
        qt.fixed_amount,
        qt.currency,
        qt.max_scans,
        qt.scan_count,
        qt.expires_at,
        qt.revoked_at,
        qt.metadata,
        qt.created_at,
        qt.updated_at,
        u.email AS creator_email,
        p.full_name AS creator_name,
        g.name AS group_name
      FROM qr_tokens qt
      INNER JOIN users u ON u.id = qt.creator_user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      LEFT JOIN groups g ON g.id = qt.target_group_id
      WHERE qt.id = $1;
    `;

    return client ? queryOneClient(client, text, [qrTokenId]) : queryOne(text, [qrTokenId]);
  }

  /**
   * Localiza e decodifica um token QR pelo seu código único de texto escaneado.
   * Une dados cadastrais do grupo e do emissor para apresentação higienizada no aplicativo ou web.
   *
   * @param {string} tokenCode
   * @param {import('pg').PoolClient} [client]
   */
  async findByTokenCode(tokenCode, client = null) {
    const text = `
      SELECT 
        qt.id,
        qt.token_code,
        qt.qr_type,
        qt.status,
        qt.creator_user_id,
        qt.target_group_id,
        qt.target_wallet_id,
        qt.payment_request_id,
        qt.fixed_amount,
        qt.currency,
        qt.max_scans,
        qt.scan_count,
        qt.expires_at,
        qt.revoked_at,
        qt.metadata,
        qt.created_at,
        p.full_name AS creator_name,
        p.preferred_name AS creator_preferred_name,
        g.name AS group_name,
        g.slug AS group_slug,
        g.status AS group_status,
        g.contribution_amount AS group_contribution_amount,
        g.frequency AS group_frequency
      FROM qr_tokens qt
      INNER JOIN users u ON u.id = qt.creator_user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      LEFT JOIN groups g ON g.id = qt.target_group_id
      WHERE qt.token_code = $1;
    `;

    return client ? queryOneClient(client, text, [tokenCode]) : queryOne(text, [tokenCode]);
  }

  /**
   * Incrementa o contador de escaneamentos/consumos e atualiza para USED caso atinja o limite máximo.
   *
   * @param {string} qrTokenId
   * @param {import('pg').PoolClient} [client]
   */
  async incrementScanCount(qrTokenId, client = null) {
    const text = `
      UPDATE qr_tokens
      SET scan_count = scan_count + 1,
          status = CASE WHEN scan_count + 1 >= max_scans THEN 'USED'::qr_token_status ELSE status END,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $1
      RETURNING id, scan_count, max_scans, status;
    `;

    return client ? queryOneClient(client, text, [qrTokenId]) : queryOne(text, [qrTokenId]);
  }

  /**
   * Revoga formalmente um Código QR emitido antes de sua expiração ou esgotamento.
   *
   * @param {string} qrTokenId
   * @param {import('pg').PoolClient} [client]
   */
  async revokeQrToken(qrTokenId, client = null) {
    const text = `
      UPDATE qr_tokens
      SET status = 'REVOKED',
          revoked_at = NOW() AT TIME ZONE 'UTC',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $1
      RETURNING id, status, revoked_at;
    `;

    return client ? queryOneClient(client, text, [qrTokenId]) : queryOne(text, [qrTokenId]);
  }

  /**
   * Lista os Códigos QR gerados por um utilizador com suporte a filtros e paginação.
   *
   * @param {string} userId
   * @param {object} [filters={}]
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listUserQrTokens(userId, filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = ['qt.creator_user_id = $1'];
    const values = [userId];
    let paramIndex = 2;

    if (filters.qrType) {
      conditions.push(`qt.qr_type = $${paramIndex}`);
      values.push(filters.qrType);
      paramIndex += 1;
    }

    if (filters.status) {
      conditions.push(`qt.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    // Contagem total
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM qr_tokens qt
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
        qt.id,
        qt.token_code,
        qt.qr_type,
        qt.status,
        qt.fixed_amount,
        qt.currency,
        qt.max_scans,
        qt.scan_count,
        qt.expires_at,
        qt.created_at,
        g.name AS group_name
      FROM qr_tokens qt
      LEFT JOIN groups g ON g.id = qt.target_group_id
      WHERE ${whereClause}
      ORDER BY qt.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }
}

// Instância singleton do repositório de QR
const qrRepository = new QrRepository();

module.exports = qrRepository;