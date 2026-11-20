const express = require('express');
const { z } = require('zod');
const reportsController = require('./reports.controller');
const { authenticate } = require('../../middleware/authenticate');
const { authorize } = require('../../middleware/authorize');
const { validateQuery, validateParams } = require('../../middleware/validate');
const { uuidSchema } = require('../../shared/validation/common.schemas');

const router = express.Router();

// Schema de validação para parâmetros de intervalo de datas (AAAA-MM-DD)
const dateRangeQuerySchema = z.object({
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

// Schema de validação para identificador do grupo em parâmetros de rota
const groupIdParamSchema = z.object({
  groupId: uuidSchema
});

/**
 * @route   GET /financial
 * @desc    Consulta o relatório analítico consolidado de volumes financeiros por período
 * @access  Privado (ADMIN, AUDITOR, FINANCIAL_OPERATOR)
 */
router.get(
  '/financial',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR'),
  validateQuery(dateRangeQuerySchema),
  reportsController.getFinancialVolumeReport
);

/**
 * @route   GET /financial/timeline
 * @desc    Consulta a série temporal diária de depósitos vs desembolsos para gráficos gerenciais
 * @access  Privado (ADMIN, AUDITOR, FINANCIAL_OPERATOR)
 */
router.get(
  '/financial/timeline',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR'),
  validateQuery(dateRangeQuerySchema),
  reportsController.getFinancialTimeline
);

/**
 * @route   GET /compliance/groups
 * @desc    Consulta o relatório global de pontualidade e adimplência de quotas de todos os grupos
 * @access  Privado (ADMIN, AUDITOR)
 */
router.get(
  '/compliance/groups',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  reportsController.getGroupComplianceReport
);

/**
 * @route   GET /compliance/groups/:groupId
 * @desc    Consulta o relatório de adimplência de um grupo de Kixikila específico
 * @access  Privado (Membros ativos, Líder do grupo, AUDITOR ou ADMIN)
 */
router.get(
  '/compliance/groups/:groupId',
  authenticate,
  validateParams(groupIdParamSchema),
  reportsController.getGroupComplianceReport
);

/**
 * @route   GET /compliance/kyc
 * @desc    Consulta o relatório analítico da esteira de verificação de identidade KYC
 * @access  Privado (ADMIN, AUDITOR)
 */
router.get(
  '/compliance/kyc',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  reportsController.getKycComplianceReport
);

/**
 * @route   GET /providers
 * @desc    Consulta o relatório de volumetria e taxa de sucesso por gateway de pagamento
 * @access  Privado (ADMIN, AUDITOR, FINANCIAL_OPERATOR)
 */
router.get(
  '/providers',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR'),
  reportsController.getProvidersPerformanceReport
);

/**
 * @route   GET /disputes-risk
 * @desc    Consulta o relatório consolidado de disputas e distribuição de eventos de risco
 * @access  Privado (ADMIN, AUDITOR)
 */
router.get(
  '/disputes-risk',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  reportsController.getDisputesAndRiskReport
);

module.exports = router;