const notificationsRepository = require('./notifications.repository');
const notificationsPolicy = require('./notifications.policy');
const notificationsConfig = require('../../config/notifications');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço de regras de negócio para a Gestão, Enfileiramento e Leitura
 * de Notificações Multicanal na plataforma OneKixikila.
 */
class NotificationsService {
  /**
   * Enfileira uma nova notificação na base de dados (In-App, SMS ou Email).
   *
   * @param {object} notificationData - Parâmetros { userId, title, message, eventType, channel, payload }
   * @param {object} [context={}]
   * @returns {Promise<object>} Registo criado
   */
  async enqueueNotification(notificationData, context = {}) {
    const structureCheck = notificationsPolicy.validateNotificationStructure(notificationData);
    if (!structureCheck.valid) {
      throw new ValidationError(structureCheck.reason);
    }

    const {
      userId,
      title,
      message,
      eventType,
      channel = 'IN_APP',
      payload = {}
    } = notificationData;

    return notificationsRepository.createNotification({
      userId,
      title,
      message,
      eventType,
      channel,
      status: 'PENDING',
      payload
    });
  }

  /**
   * Marca uma notificação individual como lida pelo utilizador autenticado (Anti-IDOR).
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} notificationId - UUID da notificação
   * @returns {Promise<object>}
   */
  async markAsRead(actingUser, notificationId) {
    const notification = await notificationsRepository.findById(notificationId);
    if (!notification) {
      throw NotFoundError.resource('Notificação', notificationId);
    }

    const check = notificationsPolicy.canMarkAsRead(actingUser, notification);
    if (!check.allowed) {
      throw new AuthorizationError(check.reason);
    }

    return notificationsRepository.markAsRead(notificationId);
  }

  /**
   * Marca todas as notificações não lidas do utilizador como lidas em lote.
   *
   * @param {object} actingUser
   * @returns {Promise<{ message: string, updatedCount: number }>}
   */
  async markAllAsRead(actingUser) {
    const updatedCount = await notificationsRepository.markAllAsRead(actingUser.id);

    return {
      message: 'Todas as notificações foram marcadas como lidas.',
      updatedCount
    };
  }

  /**
   * Consulta a contagem total de notificações não lidas do utilizador.
   *
   * @param {object} actingUser
   * @returns {Promise<{ unreadCount: number }>}
   */
  async getUnreadCount(actingUser) {
    const unreadCount = await notificationsRepository.countUnread(actingUser.id);
    return { unreadCount };
  }

  /**
   * Lista as notificações do utilizador com suporte a filtros e paginação HATEOAS.
   *
   * @param {object} actingUser
   * @param {object} filters - { isRead, channel, eventType }
   * @param {object} paginationParams - { page, limit, offset }
   * @returns {Promise<object>}
   */
  async listUserNotifications(actingUser, filters, paginationParams) {
    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await notificationsRepository.listUserNotifications(
      actingUser.id,
      filters,
      { limit, offset }
    );

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }
}

// Instância singleton do serviço de notificações
const notificationsService = new NotificationsService();

module.exports = notificationsService;