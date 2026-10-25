const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para o módulo de Chat e Comunicação de Grupos.
 * Executa consultas diretas e parametrizadas no Neon PostgreSQL para controle de mensagens
 * (texto, áudio, documentos e eventos de sistema), anexos multimédia, recibos de entrega/leitura
 * e denúncias comunitárias de moderação.
 */
class ChatRepository {
  /**
   * Insere um novo registo de mensagem na tabela chat_messages.
   *
   * @param {object} params
   * @param {string} params.groupId - UUID do grupo de Kixikila
   * @param {string|null} [params.senderId=null] - UUID do utilizador remetente (null para eventos de sistema)
   * @param {string} [params.messageType='TEXT'] - 'TEXT', 'AUDIO', 'DOCUMENT', 'SYSTEM_EVENT'
   * @param {string|null} [params.content=null] - Texto ou legenda
   * @param {string|null} [params.clientMessageId=null] - ID de deduplicação gerado no cliente
   * @param {boolean} [params.isPinned=false]
   * @param {import('pg').PoolClient} [client=null] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async createMessage(params, client = null) {
    const {
      groupId,
      senderId = null,
      messageType = 'TEXT',
      content = null,
      clientMessageId = null,
      isPinned = false
    } = params;

    const text = `
      INSERT INTO chat_messages (
        group_id,
        sender_id,
        message_type,
        content,
        client_message_id,
        is_pinned
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;

    const values = [
      groupId,
      senderId,
      messageType,
      content,
      clientMessageId,
      isPinned
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Anexa um ficheiro (áudio, documento ou imagem) à mensagem em chat_attachments.
   *
   * @param {object} params
   * @param {string} params.messageId - UUID da mensagem
   * @param {string} params.groupId - UUID do grupo
   * @param {string} params.uploaderId - UUID do remetente
   * @param {string} params.attachmentType - 'AUDIO', 'DOCUMENT', 'IMAGE'
   * @param {string} [params.bucketName='documentos'] - Bucket privado do Neon Object Storage
   * @param {string} params.storageKey - Chave aleatória gerada no backend
   * @param {string} params.originalFilename - Nome original do ficheiro
   * @param {number} params.fileSizeBytes - Tamanho em bytes (estritamente <= 5 MB para docs e <= 10 MB para áudio)
   * @param {string} params.mimeType - Tipo MIME validado
   * @param {string} params.fileHashSha256 - Checksum para integridade
   * @param {number|null} [params.durationSeconds=null] - Duração em segundos (para áudios)
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<object>}
   */
  async addAttachment(params, client = null) {
    const {
      messageId,
      groupId,
      uploaderId,
      attachmentType,
      bucketName = 'documentos',
      storageKey,
      originalFilename,
      fileSizeBytes,
      mimeType,
      fileHashSha256,
      durationSeconds = null
    } = params;

    const text = `
      INSERT INTO chat_attachments (
        message_id,
        group_id,
        uploader_id,
        attachment_type,
        bucket_name,
        storage_key,
        original_filename,
        file_size_bytes,
        mime_type,
        file_hash_sha256,
        duration_seconds
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *;
    `;

    const values = [
      messageId,
      groupId,
      uploaderId,
      attachmentType,
      bucketName,
      storageKey,
      originalFilename,
      fileSizeBytes,
      mimeType,
      fileHashSha256,
      durationSeconds
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza uma mensagem pelo seu identificador primário UUID, unindo dados do remetente e anexos.
   *
   * @param {string} messageId
   * @param {import('pg').PoolClient} [client=null]
   */
  async findById(messageId, client = null) {
    const text = `
      SELECT 
        cm.id,
        cm.group_id,
        cm.sender_id,
        cm.message_type,
        CASE WHEN cm.is_deleted = TRUE THEN 'Mensagem eliminada.' ELSE cm.content END AS content,
        cm.client_message_id,
        cm.is_pinned,
        cm.is_deleted,
        cm.deleted_at,
        cm.deleted_by,
        cm.created_at,
        cm.updated_at,
        u.email AS sender_email,
        p.full_name AS sender_name,
        p.preferred_name AS sender_preferred_name,
        p.avatar_url AS sender_avatar_url,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', ca.id,
              'attachmentType', ca.attachment_type,
              'bucketName', ca.bucket_name,
              'storageKey', ca.storage_key,
              'originalFilename', ca.original_filename,
              'fileSizeBytes', ca.file_size_bytes,
              'mimeType', ca.mime_type,
              'durationSeconds', ca.duration_seconds
            )
          ) FILTER (WHERE ca.id IS NOT NULL),
          '[]'::jsonb
        ) AS attachments
      FROM chat_messages cm
      LEFT JOIN users u ON u.id = cm.sender_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      LEFT JOIN chat_attachments ca ON ca.message_id = cm.id
      WHERE cm.id = $1
      GROUP BY cm.id, u.email, p.full_name, p.preferred_name, p.avatar_url;
    `;

    return client ? queryOneClient(client, text, [messageId]) : queryOne(text, [messageId]);
  }

  /**
   * Localiza mensagem por identificador de cliente para verificação de duplicidade (Anti-replay/deduplicação).
   *
   * @param {string} groupId
   * @param {string} clientMessageId
   * @param {import('pg').PoolClient} [client=null]
   */
  async findByClientMessageId(groupId, clientMessageId, client = null) {
    const text = `
      SELECT id, group_id, sender_id, message_type, content, client_message_id, created_at
      FROM chat_messages
      WHERE group_id = $1 AND client_message_id = $2
      LIMIT 1;
    `;

    return client ? queryOneClient(client, text, [groupId, clientMessageId]) : queryOne(text, [groupId, clientMessageId]);
  }

  /**
   * Consulta a linha do tempo cronológica de mensagens de um grupo com anexos e paginação.
   *
   * @param {string} groupId
   * @param {object} [options={}] - { limit, offset, before, messageType }
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listGroupMessages(groupId, options = {}, client = null) {
    const { limit = 50, offset = 0, before = null, messageType = null } = options;

    const conditions = ['cm.group_id = $1'];
    const values = [groupId];
    let paramIndex = 2;

    if (before) {
      conditions.push(`cm.created_at < $${paramIndex}`);
      values.push(new Date(before));
      paramIndex += 1;
    }

    if (messageType) {
      conditions.push(`cm.message_type = $${paramIndex}`);
      values.push(messageType.toUpperCase());
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    // 1. Contagem total
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM chat_messages cm
      WHERE ${whereClause};
    `;
    const countResult = client ? await queryOneClient(client, countSql, values) : await queryOne(countSql, values);
    const totalCount = countResult ? countResult.total : 0;

    // 2. Linhas paginadas
    values.push(limit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    values.push(offset);
    const offsetParam = `$${paramIndex}`;

    const dataSql = `
      SELECT 
        cm.id,
        cm.group_id,
        cm.sender_id,
        cm.message_type,
        CASE WHEN cm.is_deleted = TRUE THEN 'Mensagem eliminada.' ELSE cm.content END AS content,
        cm.client_message_id,
        cm.is_pinned,
        cm.is_deleted,
        cm.created_at,
        p.full_name AS sender_name,
        p.preferred_name AS sender_preferred_name,
        p.avatar_url AS sender_avatar_url,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', ca.id,
              'attachmentType', ca.attachment_type,
              'originalFilename', ca.original_filename,
              'fileSizeBytes', ca.file_size_bytes,
              'mimeType', ca.mime_type,
              'durationSeconds', ca.duration_seconds
            )
          ) FILTER (WHERE ca.id IS NOT NULL),
          '[]'::jsonb
        ) AS attachments
      FROM chat_messages cm
      LEFT JOIN users u ON u.id = cm.sender_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      LEFT JOIN chat_attachments ca ON ca.message_id = cm.id
      WHERE ${whereClause}
      GROUP BY cm.id, p.full_name, p.preferred_name, p.avatar_url
      ORDER BY cm.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }

  /**
   * Executa a eliminação lógica (Soft Delete) de uma mensagem com registo de auditoria do autor da remoção.
   *
   * @param {string} messageId
   * @param {string} deletedBy - UUID do utilizador ou moderador
   * @param {import('pg').PoolClient} [client=null]
   */
  async softDeleteMessage(messageId, deletedBy, client = null) {
    const text = `
      UPDATE chat_messages
      SET is_deleted = TRUE,
          deleted_at = NOW() AT TIME ZONE 'UTC',
          deleted_by = $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2
      RETURNING id, is_deleted, deleted_at, deleted_by;
    `;

    return client ? queryOneClient(client, text, [deletedBy, messageId]) : queryOne(text, [deletedBy, messageId]);
  }

  /**
   * Altera a fixação de destaque de uma mensagem no topo da sala (Pin/Unpin).
   *
   * @param {string} messageId
   * @param {boolean} isPinned
   * @param {import('pg').PoolClient} [client=null]
   */
  async setPinnedStatus(messageId, isPinned, client = null) {
    const text = `
      UPDATE chat_messages
      SET is_pinned = $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2
      RETURNING id, is_pinned, updated_at;
    `;

    return client ? queryOneClient(client, text, [isPinned, messageId]) : queryOne(text, [isPinned, messageId]);
  }

  /**
   * Consulta os avisos fixados ativos no grupo de Kixikila.
   *
   * @param {string} groupId
   * @param {import('pg').PoolClient} [client=null]
   */
  async listPinnedMessages(groupId, client = null) {
    const text = `
      SELECT 
        cm.id,
        cm.group_id,
        cm.sender_id,
        cm.message_type,
        cm.content,
        cm.created_at,
        p.full_name AS sender_name
      FROM chat_messages cm
      LEFT JOIN users u ON u.id = cm.sender_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE cm.group_id = $1
        AND cm.is_pinned = TRUE
        AND cm.is_deleted = FALSE
      ORDER BY cm.updated_at DESC;
    `;

    const result = client ? await queryClient(client, text, [groupId]) : await query(text, [groupId]);
    return result.rows;
  }

  /**
   * Regista a entrega ou leitura de uma mensagem por um membro em chat_message_receipts.
   *
   * @param {string} messageId
   * @param {string} userId
   * @param {boolean} [markAsRead=false]
   * @param {import('pg').PoolClient} [client=null]
   */
  async upsertReceipt(messageId, userId, markAsRead = false, client = null) {
    const text = `
      INSERT INTO chat_message_receipts (
        message_id,
        user_id,
        delivered_at,
        read_at
      )
      VALUES ($1, $2, NOW() AT TIME ZONE 'UTC', $3)
      ON CONFLICT (message_id, user_id)
      DO UPDATE SET
        read_at = CASE WHEN $3 IS NOT NULL THEN NOW() AT TIME ZONE 'UTC' ELSE chat_message_receipts.read_at END
      RETURNING *;
    `;

    const readAt = markAsRead ? new Date() : null;
    const values = [messageId, userId, readAt];
    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Insere um registo formal de denúncia comunitária na tabela chat_reports.
   *
   * @param {object} params
   * @param {string} params.messageId
   * @param {string} params.groupId
   * @param {string} params.reportedBy - UUID do denunciante
   * @param {string} params.reason
   * @param {import('pg').PoolClient} [client=null]
   */
  async createReport(params, client = null) {
    const { messageId, groupId, reportedBy, reason } = params;

    const text = `
      INSERT INTO chat_reports (
        message_id,
        group_id,
        reported_by,
        reason,
        status
      )
      VALUES ($1, $2, $3, $4, 'PENDING')
      RETURNING *;
    `;

    const values = [messageId, groupId, reportedBy, reason];
    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza uma denúncia pelo seu identificador primário UUID.
   *
   * @param {string} reportId
   * @param {import('pg').PoolClient} [client=null]
   */
  async findReportById(reportId, client = null) {
    const text = `
      SELECT 
        cr.id,
        cr.message_id,
        cr.group_id,
        cr.reported_by,
        cr.reason,
        cr.status,
        cr.reviewed_by,
        cr.reviewed_at,
        cr.resolution_notes,
        cr.created_at,
        cm.content AS reported_message_content,
        cm.sender_id AS reported_message_sender_id,
        p.full_name AS reporter_name
      FROM chat_reports cr
      INNER JOIN chat_messages cm ON cm.id = cr.message_id
      INNER JOIN users u ON u.id = cr.reported_by
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE cr.id = $1;
    `;

    return client ? queryOneClient(client, text, [reportId]) : queryOne(text, [reportId]);
  }

  /**
   * Atualiza a resolução de uma denúncia de moderação.
   *
   * @param {object} params
   * @param {string} params.reportId
   * @param {string} params.status - 'REVIEWED_FLAGGED', 'REVIEWED_DISMISSED', 'ACTION_TAKEN'
   * @param {string} params.reviewedBy - UUID do moderador ou líder
   * @param {string} params.resolutionNotes
   * @param {import('pg').PoolClient} [client=null]
   */
  async updateReportResolution(params, client = null) {
    const { reportId, status, reviewedBy, resolutionNotes } = params;

    const text = `
      UPDATE chat_reports
      SET status = $1,
          reviewed_by = $2,
          resolution_notes = $3,
          reviewed_at = NOW() AT TIME ZONE 'UTC',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $4
      RETURNING *;
    `;

    const values = [status, reviewedBy, resolutionNotes, reportId];
    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Lista denúncias de determinado grupo com paginação e filtros.
   *
   * @param {string} groupId
   * @param {object} [filters={}] - { status }
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client=null]
   */
  async listGroupReports(groupId, filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = ['cr.group_id = $1'];
    const values = [groupId];
    let paramIndex = 2;

    if (filters.status) {
      conditions.push(`cr.status = $${paramIndex}`);
      values.push(filters.status.toUpperCase());
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM chat_reports cr
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
        cr.id,
        cr.message_id,
        cr.reported_by,
        cr.reason,
        cr.status,
        cr.reviewed_by,
        cr.reviewed_at,
        cr.created_at,
        p.full_name AS reporter_name,
        cm.content AS message_content
      FROM chat_reports cr
      INNER JOIN chat_messages cm ON cm.id = cr.message_id
      INNER JOIN users u ON u.id = cr.reported_by
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE ${whereClause}
      ORDER BY cr.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }
}

// Instância singleton do repositório de chat
const chatRepository = new ChatRepository();

module.exports = chatRepository;