const express = require('express');
const { z } = require('zod');
const notificationsController = require('../modules/notifications/notifications.controller');
const { authenticate } = require('../middleware/authenticate');
const { validateParams, validateQuery } = require('../middleware/validate');
const { createParamIdSchema } = require('../shared/validation/identifiers');

const router = express.Router();

const notificationIdParamSchema = createParamIdSchema('notificationId');

// Schema de validação para filtros de consulta paginada de notificações
const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  isRead: z
    .string()
    .transform((val) => val === 'true' || val === '1')
    .optional(),
  channel: z.enum(['IN_APP', 'EMAIL', 'SMS', 'PUSH']).optional(),
  eventType: z.string().trim().max(100).optional()
});

/**
 * @route   GET /
 * @desc    Consulta paginada das notificações do utilizador autenticado
 * @access  Privado
 */
router.get(
  '/',
  authenticate,
  validateQuery(listNotificationsQuerySchema),
  notificationsController.listMyNotifications
);

/**
 * @route   GET /my
 * @desc    Alias para listagem de notificações próprias
 * @access  Privado
 */
router.get(
  '/my',
  authenticate,
  validateQuery(listNotificationsQuerySchema),
  notificationsController.listMyNotifications
);

/**
 * @route   GET /unread-count
 * @desc    Consulta o total de notificações não lidas para exibição de badge na barra de navegação
 * @access  Privado
 */
router.get(
  '/unread-count',
  authenticate,
  notificationsController.getUnreadCount
);

/**
 * @route   PATCH /read-all
 * @desc    Marca todas as notificações não lidas do utilizador como lidas em lote
 * @access  Privado
 */
router.patch(
  '/read-all',
  authenticate,
  notificationsController.markAllAsRead
);

/**
 * @route   POST /read-all
 * @desc    Alias para clientes HTTP e formulários que não utilizam o verbo PATCH
 * @access  Privado
 */
router.post(
  '/read-all',
  authenticate,
  notificationsController.markAllAsRead
);

/**
 * @route   PATCH /:notificationId/read
 * @desc    Marca uma notificação individual como lida
 * @access  Privado (Apenas o destinatário)
 */
router.patch(
  '/:notificationId/read',
  authenticate,
  validateParams(notificationIdParamSchema),
  notificationsController.markAsRead
);

/**
 * @route   POST /:notificationId/read
 * @desc    Alias para confirmação de leitura individual
 * @access  Privado (Apenas o destinatário)
 */
router.post(
  '/:notificationId/read',
  authenticate,
  validateParams(notificationIdParamSchema),
  notificationsController.markAsRead
);

module.exports = router;