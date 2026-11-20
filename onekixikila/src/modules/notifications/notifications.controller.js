const notificationsService = require('./notifications.service');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Notificações Multicanal.
 * Trata requisições de consulta de notificações recebidas, contagem de itens não lidos
 * e marcação de leitura (individual ou em lote) para web, Android e iOS.
 */
class NotificationsController {
  /**
   * Consulta a lista paginada de notificações do próprio utilizador autenticado.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listMyNotifications(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        isRead: req.query.isRead !== undefined ? req.query.isRead === 'true' || req.query.isRead === '1' : undefined,
        channel: req.query.channel,
        eventType: req.query.eventType
      };

      const result = await notificationsService.listUserNotifications(
        req.user,
        filters,
        paginationParams
      );

      return res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Retorna a quantidade total de notificações não lidas da conta autenticada.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getUnreadCount(req, res, next) {
    try {
      const result = await notificationsService.getUnreadCount(req.user);

      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Marca uma notificação individual como lida.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async markAsRead(req, res, next) {
    try {
      const notificationId = req.params.notificationId;
      const updated = await notificationsService.markAsRead(req.user, notificationId);

      return res.status(200).json({
        success: true,
        message: 'Notificação marcada como lida.',
        data: {
          notification: updated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Marca todas as notificações não lidas do utilizador como lidas em lote.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async markAllAsRead(req, res, next) {
    try {
      const result = await notificationsService.markAllAsRead(req.user);

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          updatedCount: result.updatedCount
        }
      });
    } catch (error) {
      return next(error);
    }
  }
}

// Instância singleton do controlador com vinculação de contexto
const notificationsController = new NotificationsController();
notificationsController.listMyNotifications = notificationsController.listMyNotifications.bind(notificationsController);
notificationsController.getUnreadCount = notificationsController.getUnreadCount.bind(notificationsController);
notificationsController.markAsRead = notificationsController.markAsRead.bind(notificationsController);
notificationsController.markAllAsRead = notificationsController.markAllAsRead.bind(notificationsController);

module.exports = notificationsController;