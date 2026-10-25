const path = require('path');
const fs = require('fs');
const chatRepository = require('./chat.repository');
const { chatPolicy, DOCUMENT_MAX_BYTES, AUDIO_MAX_BYTES } = require('./chat.policy');
const storageConfig = require('../../config/storage');
const cryptoUtils = require('../../shared/utils/crypto');
const { sanitizeFileName } = require('../../shared/security/sanitize');
const ValidationError = require('../../shared/errors/validation-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const AuthorizationError = require('../../shared/errors/authorization-error');

/**
 * Serviço especializado no processamento, validação profunda de bytes,
 * imposição estrita de limites físicos e armazenamento privado de anexos de chat
 * (documentos até 5 MB e notas de voz até 10 MB / 120s) na plataforma OneKixikila.
 */
class AttachmentService {
  /**
   * Processa, valida a integridade de tamanho/conteúdo, calcula o hash SHA-256,
   * grava no armazenamento seguro e persiste os metadados do anexo na base de dados.
   *
   * @param {object} params
   * @param {string} params.messageId - UUID da mensagem associada
   * @param {string} params.groupId - UUID do grupo de Kixikila
   * @param {string} params.uploaderId - UUID do utilizador remetente
   * @param {'AUDIO'|'DOCUMENT'|'IMAGE'} params.attachmentType - Tipo canónico de anexo
   * @param {object} params.file - Ficheiro multipart em memória ({ originalname, buffer, size, mimetype })
   * @param {number|null} [params.durationSeconds=null] - Duração em segundos (para áudio)
   * @param {import('pg').PoolClient} [client=null] - Conexão transacional opcional
   * @returns {Promise<object>} Registo do anexo persistido
   */
  async processAndStoreAttachment(params, client = null) {
    const {
      messageId,
      groupId,
      uploaderId,
      attachmentType,
      file,
      durationSeconds = null
    } = params;

    if (!file || !file.buffer) {
      throw ValidationError.fieldRequired('file (conteúdo do anexo)');
    }

    const fileSizeBytes = file.size || file.buffer.length;

    // 1. Imposição de limites físicos inegociáveis no backend
    if (attachmentType === 'DOCUMENT') {
      const docCheck = chatPolicy.validateDocumentAttachment(fileSizeBytes, file.mimetype);
      if (!docCheck.valid) {
        throw new ValidationError(docCheck.reason);
      }
    } else if (attachmentType === 'AUDIO') {
      const audioCheck = chatPolicy.validateAudioAttachment(fileSizeBytes, durationSeconds);
      if (!audioCheck.valid) {
        throw new ValidationError(audioCheck.reason);
      }
    } else if (attachmentType === 'IMAGE') {
      if (fileSizeBytes > DOCUMENT_MAX_BYTES) {
        throw new ValidationError(`A imagem excede o limite máximo permitido de ${DOCUMENT_MAX_BYTES / (1024 * 1024)} MB.`);
      }
    }

    // 2. Higienização do nome original e geração de chave de armazenamento opaca
    const rawFilename = sanitizeFileName(file.originalname || `attachment_${Date.now()}`);
    const fileExtension = path.extname(rawFilename).toLowerCase() || (attachmentType === 'AUDIO' ? '.webm' : '.bin');
    const uniqueKey = cryptoUtils.randomHex(16);
    const storageKey = `chat/${groupId}/${messageId}/${uniqueKey}${fileExtension}`;

    // 3. Cálculo de integridade SHA-256 do ficheiro
    const fileHashSha256 = cryptoUtils.calculateFileHash(file.buffer);

    // 4. Gravação física no armazenamento privado
    if (storageConfig.provider === 'local-disk') {
      const targetDir = path.join(storageConfig.localUploadsDir, 'chat', groupId, messageId);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      const targetFilePath = path.join(storageConfig.localUploadsDir, storageKey);
      fs.writeFileSync(targetFilePath, file.buffer);
    }
    // Em produção com S3/Neon Object Storage, a gravação é delegada ao bucket privado 'documentos'

    // 5. Persistência dos metadados na tabela chat_attachments
    return chatRepository.addAttachment(
      {
        messageId,
        groupId,
        uploaderId,
        attachmentType,
        bucketName: storageConfig.buckets.documents, // Bucket estritamente privado
        storageKey,
        originalFilename: rawFilename,
        fileSizeBytes,
        mimeType: file.mimetype || 'application/octet-stream',
        fileHashSha256,
        durationSeconds: durationSeconds ? Number(durationSeconds) : null
      },
      client
    );
  }

  /**
   * Consulta os metadados e autoriza o descarregamento privado de um anexo de mensagem.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} attachmentId - UUID do anexo
   * @returns {Promise<object>} Metadados do anexo
   */
  async getAttachmentForDownload(actingUser, attachmentId) {
    const text = `
      SELECT 
        ca.id,
        ca.message_id,
        ca.group_id,
        ca.uploader_id,
        ca.attachment_type,
        ca.bucket_name,
        ca.storage_key,
        ca.original_filename,
        ca.file_size_bytes,
        ca.mime_type,
        ca.duration_seconds,
        g.is_private,
        g.leader_id,
        gm.status AS membership_status
      FROM chat_attachments ca
      INNER JOIN groups g ON g.id = ca.group_id
      LEFT JOIN group_memberships gm ON gm.group_id = ca.group_id AND gm.user_id = $1
      WHERE ca.id = $2;
    `;

    const { queryOne } = require('../../database/query');
    const attachment = await queryOne(text, [actingUser.id, attachmentId]);

    if (!attachment) {
      throw NotFoundError.resource('Anexo de Mensagem', attachmentId);
    }

    const isLeader = actingUser.id === attachment.leader_id;
    const isMember = attachment.membership_status === 'ACTIVE';
    const isAdmin = actingUser.role === 'ADMIN';

    if (!isAdmin && !isLeader && !isMember) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado para descarregar este anexo privado de grupo.');
    }

    return attachment;
  }
}

// Instância singleton do serviço de anexos
const attachmentService = new AttachmentService();

module.exports = attachmentService;