const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para metadados de armazenamento, auditoria de acesso
 * e estatísticas volumétricas dos buckets privados e públicos da plataforma OneKixikila.
 */
class StorageRepository {
  /**
   * Localiza os metadados de um ficheiro a partir da sua chave opaca de armazenamento (storageKey).
   *
   * @param {string} storageKey - Chave única do objeto (ex: 'chat/.../uuid.pdf' ou 'kyc/.../uuid.jpg')
   * @param {import('pg').PoolClient} [client=null] - Conexão transacional opcional
   * @returns {Promise<object|null>}
   */
  async findFileByStorageKey(storageKey, client = null) {
    const text = `
      SELECT 
        vd.id,
        'IDENTITY' AS category,
        vd.bucket_name,
        vd.storage_key,
        vd.original_filename,
        vd.file_size_bytes,
        vd.mime_type,
        vd.file_hash_sha256,
        vd.user_id,
        NULL::uuid AS group_id,
        vd.created_at
      FROM verification_documents vd
      WHERE vd.storage_key = $1

      UNION ALL

      SELECT 
        ca.id,
        'GROUP_ATTACHMENT' AS category,
        ca.bucket_name,
        ca.storage_key,
        ca.original_filename,
        ca.file_size_bytes,
        ca.mime_type,
        ca.file_hash_sha256,
        ca.uploader_id AS user_id,
        ca.group_id,
        ca.created_at
      FROM chat_attachments ca
      WHERE ca.storage_key = $1
      LIMIT 1;
    `;

    return client ? queryOneClient(client, text, [storageKey]) : queryOne(text, [storageKey]);
  }

  /**
   * Grava um registo de auditoria institucional imutável sobre o acesso ou download de um ficheiro privado.
   *
   * @param {object} params
   * @param {string} params.storageKey
   * @param {string} params.bucketName
   * @param {string|null} [params.userId=null]
   * @param {string} [params.action='EXPORT_DATA']
   * @param {string|null} [params.ipAddress=null]
   * @param {string|null} [params.userAgent=null]
   * @param {object} [params.metadata={}]
   * @param {import('pg').PoolClient} [client=null]
   */
  async recordStorageAccessAudit(params, client = null) {
    const {
      storageKey,
      bucketName,
      userId = null,
      action = 'EXPORT_DATA',
      ipAddress = null,
      userAgent = null,
      metadata = {}
    } = params;

    const text = `
      INSERT INTO audit_events (
        actor_user_id,
        ip_address,
        user_agent,
        action,
        resource_type,
        resource_id,
        metadata
      )
      VALUES ($1, $2, $3, $4, 'STORAGE_OBJECT', $5, $6::jsonb);
    `;

    const mergedMeta = {
      bucket: bucketName,
      storageKey,
      ...metadata
    };

    const values = [
      userId,
      ipAddress,
      userAgent,
      action,
      storageKey,
      JSON.stringify(mergedMeta)
    ];

    return client ? queryClient(client, text, values) : query(text, values);
  }

  /**
   * Apura métricas consolidadas de consumo volumétrico de armazenamento (bytes e contagem de ficheiros)
   * nos buckets oficiais da plataforma.
   *
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<{
   *   documentsBucketSizeBytes: bigint,
   *   documentsCount: number,
   *   kycCount: number,
   *   attachmentsCount: number
   * }>}
   */
  async getStorageUsageStats(client = null) {
    const text = `
      SELECT 
        (
          COALESCE((SELECT SUM(file_size_bytes) FROM verification_documents), 0) +
          COALESCE((SELECT SUM(file_size_bytes) FROM chat_attachments), 0)
        )::bigint AS total_documents_bytes,
        (
          SELECT COUNT(*)::integer FROM verification_documents
        ) AS kyc_count,
        (
          SELECT COUNT(*)::integer FROM chat_attachments
        ) AS attachments_count;
    `;

    const result = client ? await queryOneClient(client, text) : await queryOne(text);

    const kycCount = result ? Number(result.kyc_count) : 0;
    const attachmentsCount = result ? Number(result.attachments_count) : 0;

    return {
      documentsBucketSizeBytes: result ? BigInt(result.total_documents_bytes) : 0n,
      documentsCount: kycCount + attachmentsCount,
      kycCount,
      attachmentsCount
    };
  }

  /**
   * Localiza anexos de mensagens marcadas como eliminadas há mais de determinado período
   * para expurgo físico pelo trabalho de retenção (`storage-retention.job.js`).
   *
   * @param {number} [retentionDays=30] - Dias de tolerância antes da destruição física
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<Array<{ id: string, storage_key: string, bucket_name: string }>>}
   */
  async listPurgeableDeletedAttachments(retentionDays = 30, client = null) {
    const text = `
      SELECT ca.id, ca.storage_key, ca.bucket_name
      FROM chat_attachments ca
      INNER JOIN chat_messages cm ON cm.id = ca.message_id
      WHERE cm.is_deleted = TRUE
        AND cm.deleted_at < (NOW() AT TIME ZONE 'UTC' - ($1 || ' days')::interval);
    `;

    const result = client ? await queryClient(client, text, [retentionDays]) : await query(text, [retentionDays]);
    return result.rows;
  }

  /**
   * Remove o registo de metadados do anexo após eliminação física bem-sucedida no armazenamento.
   *
   * @param {string} attachmentId
   * @param {import('pg').PoolClient} [client=null]
   */
  async deleteAttachmentRecord(attachmentId, client = null) {
    const text = `DELETE FROM chat_attachments WHERE id = $1 RETURNING id, storage_key;`;
    return client ? queryOneClient(client, text, [attachmentId]) : queryOne(text, [attachmentId]);
  }
}

// Instância singleton do repositório de armazenamento
const storageRepository = new StorageRepository();

module.exports = storageRepository;