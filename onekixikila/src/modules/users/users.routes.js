const express = require('express');
const usersController = require('./users.controller');
const { authenticate } = require('../../middleware/authenticate');
const { authorize } = require('../../middleware/authorize');
const { validateBody, validateParams, validateQuery } = require('../../middleware/validate');
const {
  updateProfileSchema,
  updateLocationSchema,
  updatePreferencesSchema,
  updateUserRoleSchema,
  updateUserStatusSchema,
  listUsersQuerySchema
} = require('./users.schemas');
const { userIdParamSchema } = require('../../shared/validation/identifiers');

const router = express.Router();

/**
 * @route   GET /
 * @desc    Consulta paginada e filtrada de utilizadores da plataforma
 * @access  Privado (ADMIN, SUPPORT_AGENT, AUDITOR)
 */
router.get(
  '/',
  authenticate,
  authorize('ADMIN', 'SUPPORT_AGENT', 'AUDITOR'),
  validateQuery(listUsersQuerySchema),
  usersController.listUsers
);

/**
 * @route   GET /profile
 * @desc    Consulta o perfil completo do utilizador autenticado
 * @access  Privado
 */
router.get(
  '/profile',
  authenticate,
  usersController.getProfile
);

/**
 * @route   GET /profile/:userId
 * @desc    Consulta a ficha detalhada de um utilizador específico (Anti-IDOR)
 * @access  Privado (Titular ou Agentes Administrativos)
 */
router.get(
  '/profile/:userId',
  authenticate,
  validateParams(userIdParamSchema),
  usersController.getProfile
);

/**
 * @route   GET /:userId/public
 * @desc    Consulta o perfil público higienizado para membros de grupos
 * @access  Privado
 */
router.get(
  '/:userId/public',
  authenticate,
  validateParams(userIdParamSchema),
  usersController.getPublicProfile
);

/**
 * @route   PUT /profile
 * @desc    Atualiza dados do perfil do próprio utilizador autenticado
 * @access  Privado
 */
router.put(
  '/profile',
  authenticate,
  validateBody(updateProfileSchema),
  usersController.updateProfile
);

/**
 * @route   PUT /profile/:userId
 * @desc    Atualiza dados de perfil de um utilizador específico (Anti-IDOR)
 * @access  Privado (Apenas o próprio titular)
 */
router.put(
  '/profile/:userId',
  authenticate,
  validateParams(userIdParamSchema),
  validateBody(updateProfileSchema),
  usersController.updateProfile
);

/**
 * @route   PATCH /location
 * @desc    Atualiza coordenadas geográficas de descoberta de grupos
 * @access  Privado
 */
router.patch(
  '/location',
  authenticate,
  validateBody(updateLocationSchema),
  usersController.updateLocation
);

/**
 * @route   PATCH /preferences
 * @desc    Atualiza preferências de notificação, idioma e moeda
 * @access  Privado
 */
router.patch(
  '/preferences',
  authenticate,
  validateBody(updatePreferencesSchema),
  usersController.updatePreferences
);

/**
 * @route   PATCH /:userId/role
 * @desc    Altera a função global (Role) de um utilizador
 * @access  Privado (Exclusivo ADMIN)
 */
router.patch(
  '/:userId/role',
  authenticate,
  authorize('ADMIN'),
  validateParams(userIdParamSchema),
  validateBody(updateUserRoleSchema),
  usersController.changeRole
);

/**
 * @route   PATCH /:userId/status
 * @desc    Altera o estado operacional da conta (Bloquear/Suspender/Ativar)
 * @access  Privado (Exclusivo ADMIN)
 */
router.patch(
  '/:userId/status',
  authenticate,
  authorize('ADMIN'),
  validateParams(userIdParamSchema),
  validateBody(updateUserStatusSchema),
  usersController.changeStatus
);

/**
 * @route   DELETE /account
 * @desc    Solicita a desativação da própria conta (Soft Delete)
 * @access  Privado
 */
router.delete(
  '/account',
  authenticate,
  usersController.deactivateAccount
);

/**
 * @route   DELETE /:userId
 * @desc    Desativação administrativa de uma conta de utilizador
 * @access  Privado (Exclusivo ADMIN)
 */
router.delete(
  '/:userId',
  authenticate,
  authorize('ADMIN'),
  validateParams(userIdParamSchema),
  usersController.deactivateAccount
);

module.exports = router;