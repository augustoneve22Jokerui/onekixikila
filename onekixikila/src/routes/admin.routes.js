const express = require('express');
const { z } = require('zod');
const adminModuleRoutes = require('../modules/admin/admin.routes');
const reportsModuleRoutes = require('../modules/reports/reports.routes');
const disputesModuleRoutes = require('../modules/disputes/disputes.routes');
const feesService = require('../modules/fees/fees.service');
const limitsService = require('../modules/limits/limits.service');
const riskService = require('../modules/risk/risk.service');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const { createParamIdSchema } = require('../shared/validation/identifiers');
const { calculatePaginationParams } = require('../shared/validation/pagination');
const { stripControlChars } = require('../shared/security/sanitize');

const router = express.Router();

const eventIdParamSchema = createParamIdSchema('eventId');
const userIdParamSchema = createParamIdSchema('userId');

const feeCodeParamSchema = z.object({
  feeCode: z
    .string({ required_error: 'O código da tarifa é obrigatório.' })
    .trim()
    .min(3)
    .max(50)
});

// Schema de validação para cadastro de nova tarifa
const createFeeSchema = z.object({
  feeCode: z
    .string({ required_error: 'O código da tarifa é obrigatório.' })
    .trim()
    .min(3)
    .max(50)
    .regex(/^[A-Z0-9_]+$/, { message: 'O código da tarifa deve conter apenas maiúsculas, números e underscores.' }),
  name: z
    .string({ required_error: 'O nome da tarifa é obrigatório.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 3 && val.length <= 150, { message: 'O nome deve ter entre 3 e 150 caracteres.' }),
  operationType: z.enum([
    'DEPOSIT',
    'WITHDRAWAL',
    'INTERNAL_TRANSFER',
    'CONTRIBUTION_PAYMENT',
    'ROTATION_PAYOUT',
    'PLATFORM_FEE',
    'LATE_PENALTY'
  ]),
  calculationType: z.enum(['FLAT', 'PERCENTAGE', 'HYBRID']).default('FLAT'),
  flatAmount: z.coerce.number().int().min(0).default(0),
  basisPoints: z.coerce.number().int().min(0).max(2000).default(0),
  minFee: z.coerce.number().int().min(0).default(0),
  maxFee: z.coerce.number().int().min(0).optional().nullable()
});

// Schema de validação para atualização de tarifa
const updateFeeSchema = z.object({
  name: z.string().transform((val) => stripControlChars(val).trim()).optional(),
  calculationType: z.enum(['FLAT', 'PERCENTAGE', 'HYBRID']).optional(),
  flatAmount: z.coerce.number().int().min(0).optional(),
  basisPoints: z.coerce.number().int().min(0).max(2000).optional(),
  minFee: z.coerce.number().int().min(0).optional(),
  maxFee: z.coerce.number().int().min(0).optional().nullable(),
  isActive: z.boolean().optional()
});

// Schema de validação para configuração de limite operacional
const configureLimitSchema = z.object({
  tierCode: z.enum(['TIER_1_UNVERIFIED', 'TIER_2_VERIFIED', 'TIER_3_ENHANCED']),
  operationType: z.enum([
    'DEPOSIT',
    'WITHDRAWAL',
    'INTERNAL_TRANSFER',
    'CONTRIBUTION_PAYMENT',
    'ROTATION_PAYOUT'
  ]),
  scope: z.enum(['PER_TRANSACTION', 'DAILY', 'MONTHLY']),
  maxAmount: z.coerce.number().int().positive({ message: 'O valor máximo deve ser superior a zero.' }),
  maxCount: z.coerce.number().int().positive().optional().nullable(),
  isActive: z.boolean().default(true)
});

// Schema de validação para revisão de evento de risco
const reviewRiskEventSchema = z.object({
  actionTaken: z.enum(['NONE', 'CHALLENGE_REQUIRED', 'TEMPORARY_HOLD', 'ACCOUNT_FROZEN']).optional(),
  notes: z
    .string({ required_error: 'As notas de revisão técnica são obrigatórias.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 5, { message: 'As notas de revisão devem ter pelo menos 5 caracteres.' })
    .refine((val) => val.length <= 1000, { message: 'As notas de revisão não podem exceder 1000 caracteres.' })
});

// Schema de filtros e paginação para esteira de eventos de risco
const listRiskEventsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  eventType: z.string().trim().max(100).optional(),
  actionTaken: z.string().trim().max(100).optional(),
  isReviewed: z
    .string()
    .transform((val) => val === 'true' || val === '1')
    .optional()
});

// -----------------------------------------------------------------------------
// 1. SUB-MÓDULOS DE GOVERNANÇA (Admin Base, Relatórios e Disputas)
// -----------------------------------------------------------------------------

// Delegação de rotas analíticas executivas e relatórios
router.use('/reports', reportsModuleRoutes);

// Delegação de mediação e resolução de disputas
router.use('/disputes', disputesModuleRoutes);

// Delegação das rotas base de administração (dashboard, intervenção em contas e grupos, auditoria)
router.use('/', adminModuleRoutes);

// -----------------------------------------------------------------------------
// 2. MATRIZ DE TAXAS E TARIFAS DA PLATAFORMA (Fees Management)
// -----------------------------------------------------------------------------

/**
 * @route   GET /fees
 * @desc    Lista a matriz completa de tarifas vigentes e históricas da plataforma
 * @access  Privado (ADMIN, AUDITOR, FINANCIAL_OPERATOR)
 */
router.get(
  '/fees',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR'),
  async (req, res, next) => {
    try {
      const onlyActive = req.query.active !== undefined ? req.query.active === 'true' || req.query.active === '1' : null;
      const fees = await feesService.listAllFees(onlyActive);

      return res.status(200).json({
        success: true,
        data: {
          fees
        }
      });
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * @route   POST /fees
 * @desc    Cadastra uma nova tarifa na matriz institucional
 * @access  Privado (ADMIN, FINANCIAL_OPERATOR)
 */
router.post(
  '/fees',
  authenticate,
  authorize('ADMIN', 'FINANCIAL_OPERATOR'),
  validateBody(createFeeSchema),
  async (req, res, next) => {
    try {
      const created = await feesService.createFee(req.user, req.body, {
        recordAudit: req.recordAudit
      });

      return res.status(201).json({
        success: true,
        message: 'Tarifa cadastrada com sucesso na matriz institucional.',
        data: {
          fee: created
        }
      });
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * @route   PUT /fees/:feeCode
 * @desc    Atualiza parâmetros de uma tarifa, gerando nova versão auditável
 * @access  Privado (ADMIN, FINANCIAL_OPERATOR)
 */
router.put(
  '/fees/:feeCode',
  authenticate,
  authorize('ADMIN', 'FINANCIAL_OPERATOR'),
  validateParams(feeCodeParamSchema),
  validateBody(updateFeeSchema),
  async (req, res, next) => {
    try {
      const { feeCode } = req.params;
      const updated = await feesService.updateFee(req.user, feeCode, req.body, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: 'Tarifa atualizada com sucesso. Nova versão registada.',
        data: {
          fee: updated
        }
      });
    } catch (error) {
      return next(error);
    }
  }
);

// -----------------------------------------------------------------------------
// 3. MATRIZ DE LIMITES OPERACIONAIS E CONFORMIDADE KYC (Limits Management)
// -----------------------------------------------------------------------------

/**
 * @route   GET /limits
 * @desc    Lista a matriz completa de limites prudenciais por nível KYC
 * @access  Privado (ADMIN, AUDITOR, FINANCIAL_OPERATOR)
 */
router.get(
  '/limits',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR'),
  async (req, res, next) => {
    try {
      const limits = await limitsService.listAllLimits(req.user);

      return res.status(200).json({
        success: true,
        data: {
          limits
        }
      });
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * @route   POST /limits
 * @desc    Configura ou atualiza um limite operacional de transação, diário ou mensal
 * @access  Privado (ADMIN, AUDITOR, FINANCIAL_OPERATOR)
 */
router.post(
  '/limits',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR'),
  validateBody(configureLimitSchema),
  async (req, res, next) => {
    try {
      const configured = await limitsService.configureLimit(req.user, req.body, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: 'Regra de limite operacional configurada com sucesso.',
        data: {
          limit: configured
        }
      });
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * @route   GET /limits/users/:userId
 * @desc    Consulta o consumo acumulado de limites de um utilizador específico
 * @access  Privado (ADMIN, AUDITOR, FINANCIAL_OPERATOR)
 */
router.get(
  '/limits/users/:userId',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR'),
  validateParams(userIdParamSchema),
  async (req, res, next) => {
    try {
      const { userId } = req.params;
      const tier = req.query.tier || 'TIER_1_UNVERIFIED';
      const overview = await limitsService.getUserLimitOverview(userId, String(tier).toUpperCase());

      return res.status(200).json({
        success: true,
        data: {
          userId,
          tier,
          overview
        }
      });
    } catch (error) {
      return next(error);
    }
  }
);

// -----------------------------------------------------------------------------
// 4. MONITORIZAÇÃO E MITIGAÇÃO DE RISCO (Risk Engine)
// -----------------------------------------------------------------------------

/**
 * @route   GET /risk/overview
 * @desc    Consulta métricas consolidadas de alertas e anomalias de risco
 * @access  Privado (ADMIN, AUDITOR)
 */
router.get(
  '/risk/overview',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  async (req, res, next) => {
    try {
      const overview = await riskService.getRiskOverview(req.user);

      return res.status(200).json({
        success: true,
        data: overview
      });
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * @route   GET /risk/events
 * @desc    Consulta paginada da esteira de eventos de risco detectados
 * @access  Privado (ADMIN, AUDITOR)
 */
router.get(
  '/risk/events',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateQuery(listRiskEventsQuerySchema),
  async (req, res, next) => {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        riskLevel: req.query.riskLevel,
        eventType: req.query.eventType,
        actionTaken: req.query.actionTaken,
        isReviewed: req.query.isReviewed !== undefined ? req.query.isReviewed === 'true' || req.query.isReviewed === '1' : undefined
      };

      const result = await riskService.listRiskEvents(req.user, filters, paginationParams);

      return res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * @route   GET /risk/events/:eventId
 * @desc    Consulta detalhada de um evento de risco por UUID
 * @access  Privado (ADMIN, AUDITOR)
 */
router.get(
  '/risk/events/:eventId',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateParams(eventIdParamSchema),
  async (req, res, next) => {
    try {
      const { eventId } = req.params;
      const event = await riskService.getRiskEventById(req.user, eventId);

      return res.status(200).json({
        success: true,
        data: {
          riskEvent: event
        }
      });
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * @route   POST /risk/events/:eventId/review
 * @desc    Emite parecer técnico de auditoria e deliberação sobre um evento de risco
 * @access  Privado (ADMIN, AUDITOR)
 */
router.post(
  '/risk/events/:eventId/review',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateParams(eventIdParamSchema),
  validateBody(reviewRiskEventSchema),
  async (req, res, next) => {
    try {
      const { eventId } = req.params;
      const result = await riskService.reviewRiskEvent(req.user, eventId, req.body, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          riskEvent: result.riskEvent
        }
      });
    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;