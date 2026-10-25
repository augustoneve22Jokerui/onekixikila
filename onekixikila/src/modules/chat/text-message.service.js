const chatRepository = require('./chat.repository');
const { chatPolicy } = require('./chat.policy');
const groupsRepository = require('../groups/groups.repository');
const membershipsRepository = require('../memberships/memberships.repository');
const { stripControlChars } = require('../../shared/security/sanitize');
const limitsConfig = require('../../config/limits');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');
const ValidationError = require('../../shared/errors/validation-error');

const MAX_TEXT_LENGTH = limitsConfig.chat.maxTextMessageLength || 2000;

/**
 * Serviço de regras de negócio para o envio, gestão, fixação e eliminação
 * de mensagens textuais no chat privado dos Grupos de Kixikila.
 */
class TextMessageService {
  /**
   * Envia uma mensagem de texto para a sala de conversação de um grupo.
   * Valida permissões de filiação ativa, higieniza caracteres invisíveis,
   * assegura o teto de 2000 caracteres e executa deduplicação por clientMessageId.
   *
   * @param {object} actingUser - Utilizador autenticado remetente (req.user)
   * @param {string} groupId - UUID do grupo de Kixikila
   * @param {object} messageData - { content, clientMessageId }
   * @param {object} [context={}] - Contexto de rastreamento e auditoria
   * @returns {Promise<object>} Mensagem enviada e persistida
   */
  async sendTextMessage(actingUser, groupId, messageData, context = {}) {
    if (!groupId) {
      throw ValidationError.fieldRequired('groupId');
    }

    const { content, clientMessageId = null } = messageData;

    if (!content || typeof content !== 'string') {
      throw ValidationError.fieldRequired('content');
    }

    const cleanContent = stripControlChars(content).trim();
    if (cleanContent.length === 0) {
      throw new ValidationError('A mensagem não pode estar vazia.');
    }

    if (cleanContent.length > MAX_TEXT_LENGTH) {
      throw new ValidationError(`O conteúdo da mensagem não pode exceder ${MAX_TEXT_LENGTH} caracteres.`);
    }

    // 1. Localiza o grupo de Kixikila
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    // 2. Validação de permissões de filiação e sanções no chat
    const membership = await membershipsRepository.findByGroupAndUser(groupId, actingUser.id);
    const permissionCheck = chatPolicy.canSendMessage(actingUser, group, membership);
    if (!permissionCheck.allowed) {
      throw new AuthorizationError(permissionCheck.reason);
    }

    // 3. Verificação de deduplicação por clientMessageId (Anti-replay em reconexões móveis)
    if (clientMessageId) {
      const existingMsg = await chatRepository.findByClientMessageId(groupId, clientMessageId);
      if (existingMsg) {
        return chatRepository.findById(existingMsg.id);
      }
    }

    // 4. Criação da mensagem textual
    const createdMessage = await chatRepository.createMessage({
      groupId: group.id,
      senderId: actingUser.id,
      messageType: 'TEXT',
      content: cleanContent,
      clientMessageId,
      isPinned: false
    });

    // Auto-regista recibo de entrega para o próprio autor
    await chatRepository.upsertReceipt(createdMessage.id, actingUser.id, true);

    const fullMessage = {
      ...createdMessage,
      attachments: [],
      sender_name: actingUser.fullName || actingUser.preferredName,
      sender_preferred_name: actingUser.preferredName
    };

    // 5. Emissão do evento assíncrono para distribuição via WebSockets e notificações In-App
    eventBus.publish(
      EVENT_TYPES.CHAT_TEXT_MESSAGE_SENT,
      {
        messageId: createdMessage.id,
        groupId: group.id,
        senderId: actingUser.id,
        senderName: fullMessage.sender_name,
        content: cleanContent,
        createdAt: createdMessage.created_at
      },
      { requestId: context.requestId }
    );

    return fullMessage;
  }

  /**
   * Elimina logicamente (Soft Delete) uma mensagem do histórico do chat.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} messageId - UUID da mensagem
   * @param {object} [context={}]
   * @returns {Promise<{ message: string, messageId: string }>}
   */
  async deleteMessage(actingUser, messageId, context = {}) {
    const targetMessage = await chatRepository.findById(messageId);
    if (!targetMessage) {
      throw NotFoundError.resource('Mensagem', messageId);
    }

    const group = await groupsRepository.findById(targetMessage.group_id);
    const isLeader = group && (group.leader_id === actingUser.id || group.creator_id === actingUser.id);

    const check = chatPolicy.canDeleteMessage(actingUser, targetMessage, isLeader);
    if (!check.allowed) {
      throw new AuthorizationError(check.reason);
    }

    await chatRepository.softDeleteMessage(messageId, actingUser.id);

    eventBus.publish(EVENT_TYPES.CHAT_MESSAGE_DELETED, {
      messageId,
      groupId: targetMessage.group_id,
      deletedBy: actingUser.id
    }, { requestId: context.requestId });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'DELETE',
        resourceType: 'CHAT_MESSAGE',
        resourceId: messageId,
        metadata: {
          groupId: targetMessage.group_id,
          originalSenderId: targetMessage.sender_id,
          deletedBy: actingUser.id
        }
      });
    }

    return {
      message: 'Mensagem eliminada com sucesso.',
      messageId
    };
  }

  /**
   * Fixa ou desafixa um aviso no topo da sala de conversação (Ação de Liderança).
   *
   * @param {object} actingUser - Líder do grupo ou Administrador
   * @param {string} messageId - UUID da mensagem
   * @param {boolean} isPinned - Novo estado de destaque
   * @param {object} [context={}]
   * @returns {Promise<object>} Mensagem atualizada
   */
  async togglePinMessage(actingUser, messageId, isPinned, context = {}) {
    const targetMessage = await chatRepository.findById(messageId);
    if (!targetMessage) {
      throw NotFoundError.resource('Mensagem', messageId);
    }

    const group = await groupsRepository.findById(targetMessage.group_id);
    const isLeader = group && (group.leader_id === actingUser.id || group.creator_id === actingUser.id);

    const check = chatPolicy.canPinMessage(actingUser, isLeader);
    if (!check.allowed) {
      throw new AuthorizationError(check.reason);
    }

    const updated = await chatRepository.setPinnedStatus(messageId, Boolean(isPinned));

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'CHAT_MESSAGE_PIN',
        resourceId: messageId,
        metadata: {
          groupId: targetMessage.group_id,
          isPinned: Boolean(isPinned),
          modifiedBy: actingUser.id
        }
      });
    }

    return updated;
  }
}

// Instância singleton do serviço de mensagens de texto
const textMessageService = new TextMessageService();

module.exports = textMessageService;