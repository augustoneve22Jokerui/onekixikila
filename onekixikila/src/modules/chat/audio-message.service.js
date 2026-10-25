const chatRepository = require('./chat.repository');
const { chatPolicy, AUDIO_MAX_BYTES, MAX_AUDIO_DURATION_SECONDS } = require('./chat.policy');
const attachmentService = require('./attachment.service');
const groupsRepository = require('../groups/groups.repository');
const membershipsRepository = require('../memberships/memberships.repository');
const { withTransaction } = require('../../database/transaction');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');
const ValidationError = require('../../shared/errors/validation-error');

// Tipos MIME de áudio estritamente autorizados
const ALLOWED_AUDIO_MIMES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
  'audio/mpeg'
]);

/**
 * Serviço de regras de negócio para envio e processamento de Notas de Voz e Áudio
 * no chat privado dos Grupos de Kixikila da plataforma OneKixikila.
 */
class AudioMessageService {
  /**
   * Processa o envio de uma mensagem de áudio em determinada sala de grupo.
   * Valida permissões de filiação, integridade do formato multimédia, teto de 10 MB,
   * limite de 120 segundos de duração e persiste os metadados de forma atómica.
   *
   * @param {object} actingUser - Utilizador autenticado remetente (req.user)
   * @param {string} groupId - UUID do grupo de Kixikila
   * @param {object} audioParams - { durationSeconds, clientMessageId }
   * @param {object} file - Ficheiro de áudio multipart ({ originalname, buffer, size, mimetype })
   * @param {object} [context={}] - Contexto de rastreamento e auditoria
   * @returns {Promise<object>} Ficha da mensagem de áudio criada com anexo
   */
  async sendAudioMessage(actingUser, groupId, audioParams, file, context = {}) {
    if (!groupId) {
      throw ValidationError.fieldRequired('groupId');
    }

    if (!file || !file.buffer) {
      throw ValidationError.fieldRequired('audio (ficheiro de áudio)');
    }

    // 1. Validação de formato MIME
    const mimeType = (file.mimetype || '').toLowerCase();
    if (!ALLOWED_AUDIO_MIMES.has(mimeType)) {
      throw new ValidationError(
        `Formato de áudio [${file.mimetype}] não suportado. Formatos aceites: webm, ogg, mp4, aac, mpeg.`
      );
    }

    // 2. Localiza o grupo de Kixikila
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    // 3. Validação de permissões de participação e restrições cautelares
    const membership = await membershipsRepository.findByGroupAndUser(groupId, actingUser.id);
    const permissionCheck = chatPolicy.canSendMessage(actingUser, group, membership);
    if (!permissionCheck.allowed) {
      throw new AuthorizationError(permissionCheck.reason);
    }

    const { durationSeconds = null, clientMessageId = null } = audioParams;

    // 4. Verificação de deduplicação (Anti-replay por clientMessageId)
    if (clientMessageId) {
      const existingMsg = await chatRepository.findByClientMessageId(groupId, clientMessageId);
      if (existingMsg) {
        return chatRepository.findById(existingMsg.id);
      }
    }

    // 5. Validação dos limites físicos de áudio
    const duration = durationSeconds ? Number(durationSeconds) : null;
    const audioValidation = chatPolicy.validateAudioAttachment(file.size || file.buffer.length, duration);
    if (!audioValidation.valid) {
      throw new ValidationError(audioValidation.reason);
    }

    // 6. Execução atómica da gravação da mensagem e do anexo
    const createdMessage = await withTransaction(async (client) => {
      // Cria a mensagem principal com tipo 'AUDIO'
      const message = await chatRepository.createMessage(
        {
          groupId: group.id,
          senderId: actingUser.id,
          messageType: 'AUDIO',
          content: null,
          clientMessageId,
          isPinned: false
        },
        client
      );

      // Processa e armazena o ficheiro de áudio no bucket privado 'documentos'
      const attachment = await attachmentService.processAndStoreAttachment(
        {
          messageId: message.id,
          groupId: group.id,
          uploaderId: actingUser.id,
          attachmentType: 'AUDIO',
          file,
          durationSeconds: duration
        },
        client
      );

      // Auto-regista o recibo de entrega para o próprio remetente
      await chatRepository.upsertReceipt(message.id, actingUser.id, true, client);

      return {
        ...message,
        attachments: [attachment],
        sender_name: actingUser.fullName || actingUser.preferredName,
        sender_preferred_name: actingUser.preferredName
      };
    });

    // 7. Emissão do evento de domínio assíncrono para distribuição via WebSockets e notificações
    eventBus.publish(
      EVENT_TYPES.CHAT_AUDIO_MESSAGE_SENT,
      {
        messageId: createdMessage.id,
        groupId: group.id,
        senderId: actingUser.id,
        senderName: createdMessage.sender_name,
        durationSeconds: duration,
        fileSizeBytes: file.size || file.buffer.length,
        createdAt: createdMessage.created_at
      },
      { requestId: context.requestId }
    );

    return createdMessage;
  }
}

// Instância singleton do serviço de mensagens de áudio
const audioMessageService = new AudioMessageService();

module.exports = audioMessageService;