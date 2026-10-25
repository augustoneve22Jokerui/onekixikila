const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');
const { escapeSqlLike } = require('../../shared/security/sanitize');

/**
 * Repositório de persistência SQL para o módulo de Identidade e Conformidade KYC.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para gestão de processos
 * de verificação cadastral (`identity_verifications`) e ficheiros anexados (`verification_documents`).
 */
class IdentityRepository {
  /**
   * Cria ou reinicia um processo de verificação de identidade para o utilizador.
   *
   * @param {object} params
   * @param {string} params.userId
   * @param {string} params.idType - 'NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENSE'
   * @param {string} params.idNumber
   * @param {string} params.fullNameOnDocument
   * @param {string} params.birthDateOnDocument
   * @param {string|null} [params.expirationDate]
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async createVerification(params, client = null) {
    const {
      userId,
      idType,
      idNumber,
      fullNameOnDocument,
      birthDateOnDocument,
      expirationDate = null
    } = params;

    const text = `
      INSERT INTO identity_verifications (
        user_id,
        id_type,
        id_number,
        full_name_on_document,
        birth_date_on_document,
        expiration_date,
        status,
        tier,
        submitted_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'UNDER_REVIEW', 'TIER_1_UNVERIFIED', NOW() AT TIME ZONE 'UTC')
      RETURNING *;
    `;

    const values = [
      userId,
      idType,
      idNumber,
      fullNameOnDocument,
      birthDateOnDocument,
      expirationDate
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Anexa um documento digitalizado privado (frente/verso ou foto facial) ao processo de verificação.
   *
   * @param {object} docParams
   * @param {string} docParams.verificationId
   * @param {string} docParams.userId
   * @param {string} docParams.documentType - 'NATIONAL_ID', 'FACIAL_PHOTO', etc.
   * @param {string} docParams.bucketName - Padrão 'documentos'
   * @param {string} docParams.storageKey - Chave aleatória gerada pelo backend
   * @param {string} docParams.originalFilename
   * @param {number} docParams.fileSizeBytes - <= 5.242.880 bytes
   * @param {string} docParams.mimeType
   * @param {string} docParams.fileHashSha256
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async addVerificationDocument(docParams, client = null) {
    const {
      verificationId,
      userId,
      documentType,
      bucketName = 'documentos',
      storageKey,
      originalFilename,
      fileSizeBytes,
      mimeType,
      fileHashSha256
    } = docParams;

    const text = `
      INSERT INTO verification_documents (
        verification_id,
        user_id,
        document_type,
        bucket_name,
        storage_key,
        original_filename,
        file_size_bytes,
        mime_type,
        file_hash_sha256
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;

    const values = [
      verificationId,
      userId,
      documentType,
      bucketName,
      storageKey,
      originalFilename,
      fileSizeBytes,
      mimeType,
      fileHashSha256
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza o processo de verificação mais recente do utilizador com os documentos associados.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   */
  async findByUserId(userId, client = null) {
    const text = `
      SELECT 
        iv.id,
        iv.user_id,
        iv.id_type,
        iv.id_number,
        iv.full_name_on_document,
        iv.birth_date_on_document,
        iv.expiration_date,
        iv.status,
        iv.tier,
        iv.reviewed_by,
        iv.reviewed_at,
        iv.rejection_reason,
        iv.review_notes,
        iv.submitted_at,
        iv.created_at,
        iv.updated_at,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', vd.id,
              'documentType', vd.document_type,
              'originalFilename', vd.original_filename,
              'fileSizeBytes', vd.file_size_bytes,
              'mimeType', vd.mime_type,
              'isVerified', vd.is_verified,
              'createdAt', vd.created_at
            )
          ) FILTER (WHERE vd.id IS NOT NULL),
          '[]'::jsonb
        ) AS documents
      FROM identity_verifications iv
      LEFT JOIN verification_documents vd ON vd.verification_id = iv.id
      WHERE iv.user_id = $1
      GROUP BY iv.id
      ORDER BY iv.created_at DESC
      LIMIT 1;
    `;

    return client ? queryOneClient(client, text, [userId]) : queryOne(text, [userId]);
  }

  /**
   * Localiza um processo de verificação específico pelo UUID.
   *
   * @param {string} verificationId
   * @param {import('pg').PoolClient} [client]
   */
  async findById(verificationId, client = null) {
    const text = `
      SELECT 
        iv.id,
        iv.user_id,
        iv.id_type,
        iv.id_number,
        iv.full_name_on_document,
        iv.birth_date_on_document,
        iv.expiration_date,
        iv.status,
        iv.tier,
        iv.reviewed_by,
        iv.reviewed_at,
        iv.rejection_reason,
        iv.review_notes,
        iv.submitted_at,
        u.email,
        u.phone_number,
        p.full_name AS user_registered_name,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', vd.id,
              'documentType', vd.document_type,
              'bucketName', vd.bucket_name,
              'storageKey', vd.storage_key,
              'originalFilename', vd.original_filename,
              'fileSizeBytes', vd.file_size_bytes,
              'mimeType', vd.mime_type,
              'isVerified', vd.is_verified,
              'createdAt', vd.created_at
            )
          ) FILTER (WHERE vd.id IS NOT NULL),
          '[]'::jsonb
        ) AS documents
      FROM identity_verifications iv
      INNER JOIN users u ON u.id = iv.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      LEFT JOIN verification_documents vd ON vd.verification_id = iv.id
      WHERE iv.id = $1
      GROUP BY iv.id, u.email, u.phone_number, p.full_name;
    `;

    return client ? queryOneClient(client, text, [verificationId]) : queryOne(text, [verificationId]);
  }

  /**
   * Localiza um documento individual anexo pelo seu identificador para permitir download seguro.
   *
   * @param {string} documentId
   * @param {import('pg').PoolClient} [client]
   */
  async findDocumentById(documentId, client = null) {
    const text = `
      SELECT 
        id,
        verification_id,
        user_id,
        document_type,
        bucket_name,
        storage_key,
        original_filename,
        file_size_bytes,
        mime_type,
        file_hash_sha256,
        is_verified
      FROM verification_documents
      WHERE id = $1;
    `;

    return client ? queryOneClient(client, text, [documentId]) : queryOne(text, [documentId]);
  }

  /**
   * Atualiza o parecer de auditoria e conformidade do processo KYC.
   *
   * @param {object} params
   * @param {string} params.verificationId
   * @param {string} params.status - 'APPROVED', 'REJECTED', 'NEEDS_REVIEW'
   * @param {string} params.tier - 'TIER_2_VERIFIED', etc.
   * @param {string} params.reviewedBy - UUID do auditor
   * @param {string|null} [params.rejectionReason]
   * @param {string|null} [params.reviewNotes]
   * @param {import('pg').PoolClient} [client]
   */
  async updateStatus(params, client = null) {
    const {
      verificationId,
      status,
      tier,
      reviewedBy,
      rejectionReason = null,
      reviewNotes = null
    } = params;

    const text = `
      UPDATE identity_verifications
      SET status = $1,
          tier = $2,
          reviewed_by = $3,
          rejection_reason = $4,
          review_notes = $5,
          reviewed_at = NOW() AT TIME ZONE 'UTC',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $6
      RETURNING *;
    `;

    const values = [status, tier, reviewedBy, rejectionReason, reviewNotes, verificationId];
    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Verifica se determinado número de documento já se encontra aprovado por outro utilizador
   * para prevenir fraudes de identidade cruzada.
   *
   * @param {string} idNumber
   * @param {string} currentUserId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<boolean>} True se já existir documento idêntico aprovado
   */
  async isIdNumberAlreadyApproved(idNumber, currentUserId, client = null) {
    const text = `
      SELECT 1
      FROM identity_verifications
      WHERE id_number = $1
        AND status = 'APPROVED'
        AND user_id <> $2
      LIMIT 1;
    `;

    const result = client ? await queryOneClient(client, text, [idNumber, currentUserId]) : await queryOne(text, [idNumber, currentUserId]);
    return Boolean(result);
  }

  /**
   * Lista a fila de processos de verificação KYC com paginação e filtros para a auditoria.
   *
   * @param {object} filters
   * @param {object} pagination - { limit, offset }
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listVerifications(filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (filters.status) {
      conditions.push(`iv.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex += 1;
    }

    if (filters.tier) {
      conditions.push(`iv.tier = $${paramIndex}`);
      values.push(filters.tier);
      paramIndex += 1;
    }

    if (filters.search) {
      const searchPattern = `%${escapeSqlLike(filters.search)}%`;
      conditions.push(
        `(iv.id_number ILIKE $${paramIndex} OR iv.full_name_on_document ILIKE $${paramIndex} OR u.email ILIKE $${paramIndex})`
      );
      values.push(searchPattern);
      paramIndex += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Contagem total
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM identity_verifications iv
      INNER JOIN users u ON u.id = iv.user_id
      ${whereClause};
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
        iv.id,
        iv.user_id,
        iv.id_type,
        iv.id_number,
        iv.full_name_on_document,
        iv.status,
        iv.tier,
        iv.submitted_at,
        iv.reviewed_at,
        u.email,
        u.phone_number
      FROM identity_verifications iv
      INNER JOIN users u ON u.id = iv.user_id
      ${whereClause}
      ORDER BY iv.submitted_at ASC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }
}

// Instância singleton do repositório de identidade
const identityRepository = new IdentityRepository();

module.exports = identityRepository;