const express = require('express');
const groupsController = require('./groups.controller');
const { authenticate, authenticateOptional } = require('../../middleware/authenticate');
const { validateBody, validateParams, validateQuery } = require('../../middleware/validate');
const {
  createGroupSchema,
  updateGroupSchema,
  updateGroupRulesSchema,
  updateGroupLocationSchema,
  listGroupsQuerySchema,
  nearbyGroupsQuerySchema,
  groupIdParamSchema,
  groupSlugParamSchema
} = require('./groups.schemas');

const router = express.Router();

/**
 * @route   POST /
 * @desc    Criação de um novo grupo de Kixikila
 * @access  Privado (Membros autenticados)
 */
router.post(
  '/',
  authenticate,
  validateBody(createGroupSchema),
  groupsController.createGroup
);

/**
 * @route   GET /
 * @desc    Consulta paginada e filtrada de grupos públicos ou ativos no catálogo
 * @access  Público / Opcionalmente Autenticado
 */
router.get(
  '/',
  authenticateOptional,
  validateQuery(listGroupsQuerySchema),
  groupsController.listGroups
);

/**
 * @route   GET /nearby
 * @desc    Descoberta de grupos públicos próximos por geolocalização aproximada
 * @access  Público / Opcionalmente Autenticado
 */
router.get(
  '/nearby',
  authenticateOptional,
  validateQuery(nearbyGroupsQuerySchema),
  groupsController.findNearbyGroups
);

/**
 * @route   GET /slug/:slug
 * @desc    Consulta ficha de um grupo de Kixikila pelo seu slug textual de URL
 * @access  Público / Opcionalmente Autenticado
 */
router.get(
  '/slug/:slug',
  authenticateOptional,
  validateParams(groupSlugParamSchema),
  groupsController.getGroupBySlug
);

/**
 * @route   GET /:groupId
 * @desc    Consulta ficha detalhada de um grupo por UUID
 * @access  Público para grupos abertos / Privado para grupos fechados
 */
router.get(
  '/:groupId',
  authenticateOptional,
  validateParams(groupIdParamSchema),
  groupsController.getGroupById
);

/**
 * @route   PUT /:groupId
 * @desc    Atualiza dados descritivos e cadastrais do grupo
 * @access  Privado (Líder titular ou Administradores)
 */
router.put(
  '/:groupId',
  authenticate,
  validateParams(groupIdParamSchema),
  validateBody(updateGroupSchema),
  groupsController.updateGroup
);

/**
 * @route   PATCH /:groupId/rules
 * @desc    Atualiza o regulamento interno da Kixikila (permitido na fase FORMATION)
 * @access  Privado (Líder titular ou Administradores)
 */
router.patch(
  '/:groupId/rules',
  authenticate,
  validateParams(groupIdParamSchema),
  validateBody(updateGroupRulesSchema),
  groupsController.updateRules
);

/**
 * @route   PATCH /:groupId/location
 * @desc    Atualiza os dados de georreferenciação do grupo
 * @access  Privado (Líder titular ou Administradores)
 */
router.patch(
  '/:groupId/location',
  authenticate,
  validateParams(groupIdParamSchema),
  validateBody(updateGroupLocationSchema),
  groupsController.updateLocation
);

/**
 * @route   POST /:groupId/activate
 * @desc    Ativação formal do grupo para iniciar o ciclo de quotas e rotações
 * @access  Privado (Líder titular com quórum mínimo atingido)
 */
router.post(
  '/:groupId/activate',
  authenticate,
  validateParams(groupIdParamSchema),
  groupsController.activateGroup
);

/**
 * @route   POST /:groupId/pause
 * @desc    Pausa preventiva temporária das operações do grupo
 * @access  Privado (Líder titular ou Administradores)
 */
router.post(
  '/:groupId/pause',
  authenticate,
  validateParams(groupIdParamSchema),
  groupsController.pauseGroup
);

/**
 * @route   POST /:groupId/transfer-leadership
 * @desc    Transfere formalmente a liderança do grupo para outro membro ativo
 * @access  Privado (Líder titular)
 */
router.post(
  '/:groupId/transfer-leadership',
  authenticate,
  validateParams(groupIdParamSchema),
  groupsController.changeLeader
);

module.exports = router;