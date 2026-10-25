const express = require('express');
const { z } = require('zod');
const disputesController = require('./disputes.controller');
const { authenticate } = require('../../middleware/authenticate');
const { authorize } = require('../../middleware/authorize');
const { validateBody, validateParams, validateQuery } = require('../../middleware/validate');
const { uuidSchema } = require('../../shared/validation/common.schemas');
const { stripControlChars } = require('../../shared/security/sanitize');

const router = express.Router();

// Categorias canónicas de disputa (alinhadas com a migração 014)
const DISPUTE_CATEGORIES = [
  'CONTRIBUTION_UNACKNOWLEDGED',
  'ROTATION_ORDER_DISPUTE',
  'UNAUTHORIZED_TRANSACTION',
  'WALLET_DISCREPANCY',
  'LEADERSHIP_ABUSE',
  'OTHER'
];

// Estados de encerramento permitidos na deliberação de arbitragem
const RESOLUTION_STATUSES = [
  'RESOLVED_FAVOR_INITIATOR',
  'RESOLVED_FAVOR_RESPONDENT',
  'CLOSED_DISMISSED'
];

// Schema de validação para abertura de disputa
const openDisputeSchema = z.object({
  category: z.enum(DISPUTE_CATEGORIES, {
    errorMap: () => ({ message: `Categoria de contestação inválida. Valores aceites: ${DISPUTE_CATEGORIES.join(', ')}.` })
  }),

  description: z
    .string({ required_error: 'A descrição dos factos é obrigatória.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 10, { message: 'A descrição deve conter no mínimo 10 caracteres explicativos.' })
    .refine((val) => val.length <= 2000, { message: 'A descrição não pode exceder 2000 caracteres.' }),

  groupId: uuidSchema.optional().nullable(),

  contributionId: uuidSchema.optional().nullable(),

  ledgerTransactionId: uuidSchema.optional().nullable(),

  respondentUserId: uuidSchema.optional().nullable(),

  amountContested: z.coerce
    .number()
    .int({ message: 'O montante contestado deve ser um número inteiro de Kwanzas.' })
    .positive({ message: 'O montante contestado deve ser superior a zero.' })
    .optional()
    .nullable(),

  evidenceNotes: z
    .string()
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length <= 1000, { message: 'As notas probatórias não podem exceder 1000 caracteres.' })
    .optional()
    .nullable()
});

// Schema de validação para parecer de resolução de arbitragem
const resolveDisputeSchema = z.object({
  status: z.enum(RESOLUTION_STATUSES, {
    errorMap: () => ({ message: `Status de resolução inválido. Valores aceites: ${RESOLUTION_STATUSES.join(', ')}.` })
  }),

  resolutionNotes: z
    .string({ required_error: 'O parecer fundamentado de arbitragem é obrigatório.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 10, { message: 'O parecer técnico deve conter pelo menos 10 caracteres.' })
    .refine((val) => val.length <= 2000, { message: 'O parecer técnico não pode exceder 2000 caracteres.' })
});

// Schema de parâmetros de rota com disputeId
const disputeIdParamSchema = z.object({
  disputeId: uuidSchema
});

// Schema de filtros e paginação para consulta
const listDisputesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(['OPEN', 'UNDER_INVESTIGATION', ...RESOLUTION_STATUSES]).optional(),
  category: z.enum(DISPUTE_CATEGORIES).optional()
});

/**
 * @route   POST /
 * @desc    Abertura formal de uma contestação (disputa)
 * @access  Privado (Membros autenticados)
 */
router.post(
  '/',
  authenticate,
  validateBody(openDisputeSchema),
  disputesController.openDispute
);

/**
 * @route   GET /my
 * @desc    Consulta o histórico de disputas vinculadas ao próprio utilizador autenticado
 * @access  Privado
 */
router.get(
  '/my',
  authenticate,
  validateQuery(listDisputesQuerySchema),
  disputesController.listMyDisputes
);

/**
 * @route   GET /queue
 * @desc    Consulta paginada da fila geral de disputas para auditores
 * @access  Privado (ADMIN, AUDITOR)
 */
router.get(
  '/queue',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateQuery(listDisputesQuerySchema),
  disputesController.listAllDisputes
);

/**
 * @route   GET /:disputeId
 * @desc    Consulta detalhada dos autos de uma disputa por UUID
 * @access  Privado (Partes envolvidas ou Auditores)
 */
router.get(
  '/:disputeId',
  authenticate,
  validateParams(disputeIdParamSchema),
  disputesController.getDisputeById
);

/**
 * @route   POST /:disputeId/investigate
 * @desc    Promove o estado da contestação para fase investigativa (UNDER_INVESTIGATION)
 * @access  Privado (ADMIN, AUDITOR)
 */
router.post(
  '/:disputeId/investigate',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateParams(disputeIdParamSchema),
  disputesController.markUnderInvestigation
);

/**
 * @route   POST /:disputeId/resolve
 * @desc    Delibera e conclui a disputa com parecer formal de arbitragem
 * @access  Privado (ADMIN, AUDITOR)
 */
router.post(
  '/:disputeId/resolve',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateParams(disputeIdParamSchema),
  validateBody(resolveDisputeSchema),
  disputesController.resolveDispute
);

module.exports = router;