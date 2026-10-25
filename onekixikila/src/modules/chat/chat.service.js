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
 * Coordena mensagens de texto, áudio, documentos com limite inegociável de 5 MB,
 * recibos de leitura, avisos fixados, moderação comunitária e difusão em tempo real.
 */
class ChatService {
  /**
   * Envia uma mensagem textual delegando ao serviço especializado e difundindo em tempo real.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} groupId - UUID do grupo de Kixikila
   * @param {object} messageData - { content, clientMessageId }
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async sendTextMessage(actingUser, groupId, messageData, context = {}) {
    const message = await textMessageService.sendTextMessage(actingUser, groupId, messageData, context);
    chatGateway.broadcastToGroup(groupId, 'chat:new_message', message);
    return message;
  }

  /**
   * Envia uma mensagem de áudio (nota de voz) delegando ao serviço especializado.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {object} audioParams - { durationSeconds, clientMessageId }
   * @param {object} file - Ficheiro de áudio multipart
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async sendAudioMessage(actingUser, groupId, audioParams, file, context = {}) {
    const message = await audioMessageService.sendAudioMessage(actingUser, groupId, audioParams, file, context);
    chatGateway.broadcastToGroup(groupId, 'chat:new_audio', message);
    return message;
  }

  /**
   * Envia um documento anexo (PDF, comprovativo informativo, imagem) para o grupo.
   * Impõe rigorosamente o limite físico de 5 MB (5.242.880 bytes) e grava no bucket privado 'documentos'.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {object} documentParams - { caption, clientMessageId }
   * @param {object} file - Ficheiro multipart
   * @param {object} [context={}]
   * @returns {Promise<object>} Mensagem criada com anexo
   */
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

    // 1. Validação de filiação e sanções
    const membership = await membershipsRepository.findByGroupAndUser(groupId, actingUser.id);
    const permissionCheck = chatPolicy.canSendMessage(actingUser, group, membership);
    if (!permissionCheck.allowed) {
      throw new AuthorizationError(permissionCheck.reason);
    }

    const { caption = null, clientMessageId = null } = documentParams;

    // 2. Deduplicação por clientMessageId
    if (clientMessageId) {
      const existing = await chatRepository.findByClientMessageId(groupId, clientMessageId);
      if (existing) {
        return chatRepository.findById(existing.id);
      }
    }

    // 3. Validação do limite de 5 MB
    const fileSizeBytes = file.size || file.buffer.length;
    const docCheck = chatPolicy.validateDocumentAttachment(fileSizeBytes, file.mimetype);
    if (!docCheck.valid) {
      throw new ValidationError(docCheck.reason);
    }

    // 4. Execução transacional atómica
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

  /**
   * Consulta a linha do tempo cronológica de mensagens do grupo com paginação e autorização.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {object} paginationParams - { page, limit, offset, before, messageType }
   * @returns {Promise<object>}
   */
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
    const { rows, totalCount } = await chatRepository.listGroupMessages(
      groupId,
      { limit, offset, before, messageType }
    );

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }

  /**
   * Consulta os avisos e mensagens fixadas ativas no topo da sala do grupo.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @returns {Promise<Array<object>>}
   */
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

  /**
   * Elimina logicamente uma mensagem do chat (Soft Delete).
   *
   * @param {object} actingUser
   * @param {string} messageId
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async deleteMessage(actingUser, messageId, context = {}) {
    const result = await textMessageService.deleteMessage(actingUser, messageId, context);
    return result;
  }

  /**
   * Fixa ou desafixa um aviso no topo da sala de conversação (Ação de Liderança).
   *
   * @param {object} actingUser
   * @param {string} messageId
   * @param {boolean} isPinned
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async togglePinMessage(actingUser, messageId, isPinned, context = {}) {
    const updated = await textMessageService.togglePinMessage(actingUser, messageId, isPinned, context);
    chatGateway.broadcastToGroup(updated.group_id, 'chat:pin_updated', {
      messageId: updated.id,
      isPinned: updated.is_pinned
    });
    return updated;
  }

  /**
   * Marca uma mensagem como lida e emite o recibo atualizado para a sala do grupo.
   *
   * @param {object} actingUser
   * @param {string} messageId
   * @param {string} groupId
   * @returns {Promise<object>}
   */
  async markMessageAsRead(actingUser, messageId, groupId) {
    const receipt = await chatRepository.upsertReceipt(messageId, actingUser.id, true);

    chatGateway.broadcastToGroup(groupId, 'chat:receipt_updated', {
      messageId,
      userId: actingUser.id,
      readAt: receipt.read_at
    });

    return receipt;
  }

  /**
   * Submete uma denúncia formal contra mensagem no chat delegando ao serviço de moderação.
   */
  async reportMessage(actingUser, groupId, messageId, reason, context = {}) {
    return moderationService.reportMessage(actingUser, groupId, messageId, reason, context);
  }

  /**
   * Delibera e conclui uma denúncia de mensagem delegando ao serviço de moderação.
   */
  async resolveReport(actingUser, reportId, resolutionData, context = {}) {
    return moderationService.resolveReport(actingUser, reportId, resolutionData, context);
  }

  /**
   * Lista as denúncias de um grupo delegando ao serviço de moderação.
   */
  async listGroupReports(actingUser, groupId, filters, paginationParams) {
    return moderationService.listGroupReports(actingUser, groupId, filters, paginationParams);
  }
}

// Instância singleton do serviço principal de chat
const chatService = new ChatService();

module.exports = chatService;