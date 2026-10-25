const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');
const { DOCUMENT_CATEGORIES } = require('./documents.policy');

/**
 * Repositório de persistência SQL unificado para o módulo de Documentos e Ficheiros Privados.
 * Integra e consulta registos de ficheiros em `verification_documents` (documentos de identidade/KYC)
 * e `chat_attachments` (documentos e anexos de grupos de Kixikila) com consultas parametrizadas diretas
 * no Neon PostgreSQL.
 */
class DocumentsRepository {
  /**
   * Localiza um documento pelo seu identificador primário UUID, identificando se provém
   * da esteira de identidade (KYC) ou de anexos de grupos de Kixikila.
   *
   * @param {string} documentId - UUID do documento
   * @param {import('pg').PoolClient} [client=null] - Conexão transacional opcional
   * @returns {Promise<object|null>} Ficha unificada do documento
   */
  async findDocumentById(documentId, client = null) {
    const text = `
      SELECT 
        vd.id,
        'IDENTITY' AS category,
        vd.verification_id,
        NULL::uuid AS message_id,
        NULL::uuid AS group_id,
        vd.user_id,
        vd.document_type,
        vd.bucket_name,
        vd.storage_key,
        vd.original_filename,
        vd.file_size_bytes,
        vd.mime_type,
        vd.file_hash_sha256,
        vd.is_verified,
        vd.verified_at,
        NULL::integer AS duration_seconds,
        vd.created_at,
        vd.updated_at,
        u.email AS owner_email,
        p.full_name AS owner_name
      FROM verification_documents vd
      INNER JOIN users u ON u.id = vd.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE vd.id = $1

      UNION ALL

      SELECT 
        ca.id,
        'GROUP_ATTACHMENT' AS category,
        NULL::uuid AS verification_id,
        ca.message_id,
        ca.group_id,
        ca.uploader_id AS user_id,
        ca.attachment_type AS document_type,
        ca.bucket_name,
        ca.storage_key,
        ca.original_filename,
        ca.file_size_bytes,
        ca.mime_type,
        ca.file_hash_sha256,
        TRUE AS is_verified,
        ca.created_at AS verified_at,
        ca.duration_seconds,
        ca.created_at,
        ca.created_at AS updated_at,
        u.email AS owner_email,
        p.full_name AS owner_name
      FROM chat_attachments ca
      INNER JOIN users u ON u.id = ca.uploader_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE ca.id = $1;
    `;

    return client ? queryOneClient(client, text, [documentId]) : queryOne(text, [documentId]);
  }

  /**
   * Atualiza a homologação de validação de um documento de identidade (KYC).
   *
   * @param {string} documentId
   * @param {boolean} isVerified
   * @param {import('pg').PoolClient} [client=null]
   */
  async updateVerificationDocumentStatus(documentId, isVerified, client = null) {
    const text = `
      UPDATE verification_documents
      SET is_verified = $1,
          verified_at = CASE WHEN $1 = TRUE THEN NOW() AT TIME ZONE 'UTC' ELSE NULL END,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2
      RETURNING id, is_verified, verified_at, updated_at;
    `;

    return client ? queryOneClient(client, text, [isVerified, documentId]) : queryOne(text, [isVerified, documentId]);
  }

  /**
   * Lista os documentos de identidade e ficheiros pessoais de um utilizador específico com paginação.
   *
   * @param {string} userId
   * @param {object} [filters={}] - { isVerified, category }
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listUserDocuments(userId, filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = ['user_id = $1'];
    const values = [userId];
    let paramIndex = 2;

    if (filters.isVerified !== undefined) {
      conditions.push(`is_verified = $${paramIndex}`);
      values.push(filters.isVerified);
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM (
        SELECT id, user_id, is_verified FROM verification_documents
        UNION ALL
        SELECT id, uploader_id AS user_id, TRUE AS is_verified FROM chat_attachments
      ) docs
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
      SELECT *
      FROM (
        SELECT 
          vd.id,
          'IDENTITY' AS category,
          vd.document_type,
          vd.bucket_name,
          vd.storage_key,
          vd.original_filename,
          vd.file_size_bytes,
          vd.mime_type,
          vd.is_verified,
          vd.created_at
        FROM verification_documents vd
        WHERE vd.user_id = $1

        UNION ALL

        SELECT 
          ca.id,
          'GROUP_ATTACHMENT' AS category,
          ca.attachment_type AS document_type,
          ca.bucket_name,
          ca.storage_key,
          ca.original_filename,
          ca.file_size_bytes,
          ca.mime_type,
          TRUE AS is_verified,
          ca.created_at
        FROM chat_attachments ca
        WHERE ca.uploader_id = $1
      ) all_docs
      ORDER BY created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }

  /**
   * Lista os documentos e anexos partilhados dentro de determinado grupo de Kixikila.
   *
   * @param {string} groupId
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listGroupDocuments(groupId, pagination = { limit: 20, offset: 0 }, client = null) {
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM chat_attachments
      WHERE group_id = $1;
    `;
    const countResult = client ? await queryOneClient(client, countSql, [groupId]) : await queryOne(countSql, [groupId]);
    const totalCount = countResult ? countResult.total : 0;

    const dataSql = `
      SELECT 
        ca.id,
        'GROUP_ATTACHMENT' AS category,
        ca.message_id,
        ca.group_id,
        ca.uploader_id,
        ca.attachment_type,
        ca.bucket_name,
        ca.storage_key,
        ca.original_filename,
        ca.file_size_bytes,
        ca.mime_type,
        ca.created_at,
        p.full_name AS uploader_name
      FROM chat_attachments ca
      INNER JOIN users u ON u.id = ca.uploader_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE ca.group_id = $1
      ORDER BY ca.created_at DESC
      LIMIT $2 OFFSET $3;
    `;

    const dataResult = client
      ? await queryClient(client, dataSql, [groupId, pagination.limit, pagination.offset])
      : await query(dataSql, [groupId, pagination.limit, pagination.offset]);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }

  /**
   * Elimina o registo de um documento em verification_documents ou chat_attachments.
   *
   * @param {string} documentId
   * @param {string} category - 'IDENTITY' ou 'GROUP_ATTACHMENT'
   * @param {import('pg').PoolClient} [client=null]
   */
  async deleteDocumentRecord(documentId, category, client = null) {
    const tableName = category === DOCUMENT_CATEGORIES.IDENTITY ? 'verification_documents' : 'chat_attachments';
    const text = `DELETE FROM ${tableName} WHERE id = $1 RETURNING id, storage_key, bucket_name;`;
    return client ? queryOneClient(client, text, [documentId]) : queryOne(text, [documentId]);
  }
}

// Instância singleton do repositório de documentos
const documentsRepository = new DocumentsRepository();

module.exports = documentsRepository;