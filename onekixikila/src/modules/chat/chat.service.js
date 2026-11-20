// =============================================================================
// modules/chat/chat.service.js
// =============================================================================

const chatRepository = require('./chat.repository');
const { chatPolicy, DOCUMENT_MAX_BYTES } = require('./chat.policy');
const textMessageService = require('./text-message.service');
const audioMessageService = require('./audio-message.service');
const attachmentService = require('./attachment.service');
const moderationService = require('./moderation.service');
const chatGateway = require('./chat.gateway');
const groupsRepository = require('../groups/groups.repository');
const membershipsRepository = require('../memberships/memberships.repository');
const { withTransaction } = require('../../database/transaction');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço central orquestrador do Módulo de Chat e Comunicação de Grupos.
 */
class ChatService {
  async sendTextMessage(actingUser, groupId, messageData, context = {}) {
    const message = await textMessageService.sendTextMessage(
      actingUser,
      groupId,
      messageData,
      context
    );
    chatGateway.broadcastToGroup(groupId, 'chat:new_message', message);
    return message;
  }

  async sendAudioMessage(actingUser, groupId, audioParams, file, context = {}) {
    const message = await audioMessageService.sendAudioMessage(
      actingUser,
      groupId,
      audioParams,
      file,
      context
    );
    chatGateway.broadcastToGroup(groupId, 'chat:new_audio', message);
    return message;
  }

  async sendDocumentMessage(actingUser, groupId, documentParams, file, context = {}) {
    if (!groupId) {
      throw ValidationError.fieldRequired('groupId');
    }

    if (!file || !file.buffer) {
      throw ValidationError.fieldRequired('document (ficheiro anexo)');
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

    const { caption = null, clientMessageId = null } = documentParams;

    if (clientMessageId) {
      const existing = await chatRepository.findByClientMessageId(groupId, clientMessageId);
      if (existing) {
        return chatRepository.findById(existing.id);
      }
    }

    const fileSizeBytes = file.size || file.buffer.length;
    const docCheck = chatPolicy.validateDocumentAttachment(fileSizeBytes, file.mimetype);
    if (!docCheck.valid) {
      throw new ValidationError(docCheck.reason);
    }

    const createdMessage = await withTransaction(async (client) => {
      const message = await chatRepository.createMessage(
        {
          groupId: group.id,
          senderId: actingUser.id,
          messageType: 'DOCUMENT',
          content: caption ? caption.trim() : null,
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
          attachmentType: 'DOCUMENT',
          file
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
      EVENT_TYPES.CHAT_DOCUMENT_SENT,
      {
        messageId: createdMessage.id,
        groupId: group.id,
        senderId: actingUser.id,
        senderName: createdMessage.sender_name,
        originalFilename: file.originalname,
        fileSizeBytes,
        createdAt: createdMessage.created_at
      },
      { requestId: context.requestId }
    );

    chatGateway.broadcastToGroup(groupId, 'chat:new_document', createdMessage);

    return createdMessage;
  }

  async getGroupMessages(actingUser, groupId, paginationParams) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const membership = await membershipsRepository.findByGroupAndUser(groupId, actingUser.id);
    const accessCheck = chatPolicy.canAccessChat(actingUser, group, membership);
    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    const { limit, offset, page, before, messageType } = paginationParams;
    const { rows, totalCount } = await chatRepository.listGroupMessages(groupId, {
      limit,
      offset,
      before,
      messageType
    });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }

  async getPinnedMessages(actingUser, groupId) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const membership = await membershipsRepository.findByGroupAndUser(groupId, actingUser.id);
    const accessCheck = chatPolicy.canAccessChat(actingUser, group, membership);
    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    return chatRepository.listPinnedMessages(groupId);
  }

  async deleteMessage(actingUser, messageId, context = {}) {
    return textMessageService.deleteMessage(actingUser, messageId, context);
  }

  async togglePinMessage(actingUser, messageId, isPinned, context = {}) {
    const updated = await textMessageService.togglePinMessage(
      actingUser,
      messageId,
      isPinned,
      context
    );
    chatGateway.broadcastToGroup(updated.group_id, 'chat:pin_updated', {
      messageId: updated.id,
      isPinned: updated.is_pinned
    });
    return updated;
  }

  async markMessageAsRead(actingUser, messageId, groupId) {
    if (!actingUser || !actingUser.id) {
      throw new AuthorizationError('A autenticação é necessária para confirmar a leitura.');
    }
    if (!messageId) {
      throw ValidationError.fieldRequired('messageId');
    }
    if (!groupId) {
      throw ValidationError.fieldRequired('groupId');
    }

    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const membership = await membershipsRepository.findByGroupAndUser(groupId, actingUser.id);
    const accessCheck = chatPolicy.canAccessChat(actingUser, group, membership);
    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    const message = await chatRepository.findById(messageId);
    if (!message) {
      throw NotFoundError.resource('Mensagem', messageId);
    }

    if (String(message.group_id) !== String(group.id)) {
      throw new ConflictError('A mensagem não pertence ao grupo indicado.');
    }

    const receipt = await chatRepository.upsertReceipt(messageId, actingUser.id, true);

    chatGateway.broadcastToGroup(group.id, 'chat:receipt_updated', {
      messageId,
      userId: actingUser.id,
      readAt: receipt.read_at
    });

    return receipt;
  }

  async reportMessage(actingUser, groupId, messageId, reason, context = {}) {
    return moderationService.reportMessage(actingUser, groupId, messageId, reason, context);
  }

  async resolveReport(actingUser, reportId, resolutionData, context = {}) {
    return moderationService.resolveReport(actingUser, reportId, resolutionData, context);
  }

  async listGroupReports(actingUser, groupId, filters, paginationParams) {
    return moderationService.listGroupReports(actingUser, groupId, filters, paginationParams);
  }
}

const chatService = new ChatService();

module.exports = chatService;
