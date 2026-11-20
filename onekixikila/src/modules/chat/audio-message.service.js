// =============================================================================
// modules/chat/audio-message.service.js
// =============================================================================

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
const ValidationError = require('../../shared/errors/validation-error');

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
  async sendAudioMessage(actingUser, groupId, audioParams, file, context = {}) {
    if (!groupId) {
      throw ValidationError.fieldRequired('groupId');
    }

    if (!file || !file.buffer) {
      throw ValidationError.fieldRequired('audio (ficheiro de áudio)');
    }

    const mimeType = (file.mimetype || '').toLowerCase();
    if (!ALLOWED_AUDIO_MIMES.has(mimeType)) {
      throw new ValidationError(
        `Formato de áudio [${file.mimetype}] não suportado. Formatos aceites: webm, ogg, mp4, aac, mpeg.`
      );
    }

    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const membership = await membershipsRepository.findByGroupAndUser(groupId, actingUser.id);
    const permissionCheck = chatPolicy.canSendMessage(actingUser, group, membership);
    if (!permissionCheck.allowed) {
      throw new AuthorizationError(permissionCheck.reason);
    }

    const { durationSeconds = null, clientMessageId = null } = audioParams;

    if (clientMessageId) {
      const existingMsg = await chatRepository.findByClientMessageId(groupId, clientMessageId);
      if (existingMsg) {
        return chatRepository.findById(existingMsg.id);
      }
    }

    const duration = durationSeconds ? Number(durationSeconds) : null;
    const audioValidation = chatPolicy.validateAudioAttachment(
      file.size || file.buffer.length,
      duration
    );
    if (!audioValidation.valid) {
      throw new ValidationError(audioValidation.reason);
    }

    const createdMessage = await withTransaction(async (client) => {
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

      await chatRepository.upsertReceipt(message.id, actingUser.id, true, client);

      return {
        ...message,
        attachments: [attachment],
        sender_name: actingUser.fullName || actingUser.preferredName,
        sender_preferred_name: actingUser.preferredName
      };
    });

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

const audioMessageService = new AudioMessageService();

module.exports = audioMessageService;