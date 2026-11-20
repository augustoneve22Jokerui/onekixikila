const express = require('express');
const { z } = require('zod');
const adminController = require('./admin.controller');
const { authenticate } = require('../../middleware/authenticate');
const { authorize } = require('../../middleware/authorize');
const { validateBody, validateParams, validateQuery } = require('../../middleware/validate');
const { uuidSchema } = require('../../shared/validation/common.schemas');
const { ALL_USER_ROLES } = require('../../shared/constants/roles');
const { USER_STATUSES } = require('../../shared/constants/statuses');
const { stripControlChars } = require('../../shared/security/sanitize');

const router = express.Router();

// Parâmetros de rota validados
const userIdParamSchema = z.object({
  userId: uuidSchema
});

const groupIdParamSchema = z.object({
  groupId: uuidSchema
});

// Schema de validação para alteração de papel global de utilizador
const updateUserRoleSchema = z.object({
  role: z.enum(ALL_USER_ROLES, {
    errorMap: () => ({ message: `Papel de utilizador inválido. Papéis aceites: ${ALL_USER_ROLES.join(', ')}.` })
  })
});

// Schema de validação para alteração de estado operacional de utilizador
const updateUserStatusSchema = z.object({
  status: z.enum(Object.values(USER_STATUSES), {
    errorMap: () => ({ message: 'Estado operacional de utilizador inválido.' })
  }),
  reason: z
    .string({ required_error: 'A justificativa para a alteração de estado é obrigatória.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 5, { message: 'A justificativa deve conter no mínimo 5 caracteres.' })
    .refine((val) => val.length <= 255, { message: 'A justificativa não pode exceder 255 caracteres.' })
});

// Schema de validação para alteração de estado operacional de grupo
const updateGroupStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'PAUSED', 'SUSPENDED'], {
    errorMap: () => ({ message: "O estado do grupo deve ser 'ACTIVE', 'PAUSED' ou 'SUSPENDED'." })
  }),
  reason: z
    .string({ required_error: 'A justificativa para a intervenção no grupo é obrigatória.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 5, { message: 'A justificativa deve conter pelo menos 5 caracteres.' })
    .refine((val) => val.length <= 255, { message: 'A justificativa não pode exceder 255 caracteres.' })
});

// Schema de validação para substituição compulsória de liderança de grupo
const forceLeaderChangeSchema = z.object({
  newLeaderId: uuidSchema,
  reason: z
    .string({ required_error: 'A justificativa para a substituição de liderança é obrigatória.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 5, { message: 'A justificativa deve conter pelo menos 5 caracteres.' })
    .refine((val) => val.length <= 255, { message: 'A justificativa não pode exceder 255 caracteres.' })
});

// Schema de filtros e paginação para consulta de grupos na esteira administrativa
const listAdminGroupsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(['DRAFT', 'FORMATION', 'ACTIVE', 'PAUSED', 'COMPLETED', 'SUSPENDED', 'CANCELLED']).optional(),
  frequency: z.enum(['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY']).optional(),
  search: z.string().trim().max(100).optional()
});

// Schema de filtros e paginação para consulta de registos de auditoria institucional
const listAuditLogsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  action: z.string().trim().max(50).optional(),
  resourceType: z.string().trim().max(100).optional(),
  actorUserId: uuidSchema.optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'A data inicial deve seguir o formato AAAA-MM-DD.' })
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'A data final deve seguir o formato AAAA-MM-DD.' })
    .optional()
}).superRefine((data, ctx) => {
  if (data.startDate && data.endDate) {
    if (new Date(data.startDate) > new Date(data.endDate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A data inicial não pode ser posterior à data final.',
        path: ['startDate']
      });
    }
  }
});

/**
 * @route   GET /dashboard
 * @desc    Consulta métricas agregadas e indicadores consolidados para o painel executivo
 * @access  Privado (ADMIN, AUDITOR, SUPPORT_AGENT, FINANCIAL_OPERATOR)
 */
router.get(
  '/dashboard',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'SUPPORT_AGENT', 'FINANCIAL_OPERATOR'),
  adminController.getDashboardOverview
);

/**
 * @route   GET /users/:userId
 * @desc    Consulta a ficha técnica aprofundada de um utilizador para fins de auditoria
 * @access  Privado (ADMIN, AUDITOR, SUPPORT_AGENT)
 */
router.get(
  '/users/:userId',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'SUPPORT_AGENT'),
  validateParams(userIdParamSchema),
  adminController.getUserDetails
);

/**
 * @route   PATCH /users/:userId/role
 * @desc    Altera administrativamente a função global (Role) de um utilizador
 * @access  Privado (Exclusivo ADMIN)
 */
router.patch(
  '/users/:userId/role',
  authenticate,
  authorize('ADMIN'),
  validateParams(userIdParamSchema),
  validateBody(updateUserRoleSchema),
  adminController.updateUserRole
);

/**
 * @route   PATCH /users/:userId/status
 * @desc    Altera o estado operacional de uma conta (bloquear, suspender ou reativar)
 * @access  Privado (ADMIN, AUDITOR)
 */
router.patch(
  '/users/:userId/status',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateParams(userIdParamSchema),
  validateBody(updateUserStatusSchema),
  adminController.updateUserStatus
);

/**
 * @route   GET /groups
 * @desc    Consulta a lista de grupos para esteira de supervisão administrativa
 * @access  Privado (ADMIN, AUDITOR)
 */
router.get(
  '/groups',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateQuery(listAdminGroupsQuerySchema),
  adminController.listGroups
);

/**
 * @route   GET /groups/:groupId
 * @desc    Consulta detalhada de um grupo de Kixikila para intervenção ou auditoria
 * @access  Privado (ADMIN, AUDITOR)
 */
router.get(
  '/groups/:groupId',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateParams(groupIdParamSchema),
  adminController.getGroupDetails
);

/**
 * @route   PATCH /groups/:groupId/status
 * @desc    Altera o estado operacional de um grupo (pausa ou suspensão preventiva)
 * @access  Privado (ADMIN, AUDITOR)
 */
router.patch(
  '/groups/:groupId/status',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateParams(groupIdParamSchema),
  validateBody(updateGroupStatusSchema),
  adminController.updateGroupStatus
);

/**
 * @route   POST /groups/:groupId/force-leader
 * @desc    Substituição compulsória da liderança de um grupo por contingência
 * @access  Privado (Exclusivo ADMIN)
 */
router.post(
  '/groups/:groupId/force-leader',
  authenticate,
  authorize('ADMIN'),
  validateParams(groupIdParamSchema),
  validateBody(forceLeaderChangeSchema),
  adminController.forceChangeGroupLeader
);

/**
 * @route   GET /audit-logs
 * @desc    Consulta a esteira de registos de auditoria institucional (audit_events)
 * @access  Privado (ADMIN, AUDITOR)
 */
router.get(
  '/audit-logs',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateQuery(listAuditLogsQuerySchema),
  adminController.listAuditLogs
);

/**
 * @route   GET /settings
 * @desc    Consulta os parâmetros operacionais e configurações vigentes da plataforma
 * @access  Privado (ADMIN, AUDITOR, FINANCIAL_OPERATOR)
 */
router.get(
  '/settings',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR'),
  adminController.getSystemSettings
);

module.exports = router;