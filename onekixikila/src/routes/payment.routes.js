const express = require('express');
const { z } = require('zod');
const paymentsController = require('../modules/payments/payments.controller');
const webhookController = require('../payments/webhooks/webhook.controller');
const reconciliationService = require('../payments/reconciliation/reconciliation.service');
const reconciliationRepository = require('../payments/reconciliation/reconciliation.repository');
const reconciliationPolicy = require('../payments/reconciliation/reconciliation.policy');
const qrController = require('../modules/qr/qr.controller');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const { financialLimiter } = require('../middleware/rate-limit');
const idempotency = require('../middleware/idempotency');
const {
  initiatePaymentSchema,
  paymentIdParamSchema,
  listPaymentsQuerySchema
} = require('../modules/payments/payments.schemas');
const {
  generatePaymentQrSchema,
  scanQrTokenSchema,
  consumePaymentQrSchema,
  qrTokenIdParamSchema,
  tokenCodeParamSchema,
  listQrTokensQuerySchema
} = require('../modules/qr/qr.schemas');
const { createParamIdSchema } = require('../shared/validation/identifiers');
const { calculatePaginationParams } = require('../shared/validation/pagination');
const { stripControlChars } = require('../shared/security/sanitize');

const router = express.Router();

// Schema de parâmetros para lote de conciliação
const batchReferenceParamSchema = z.object({
  batchReference: z
    .string({ required_error: 'A referência do lote de conciliação é obrigatória.' })
    .trim()
    .min(6)
    .max(64)
});

// Schema de validação para disparo manual de conciliação financeira
const triggerReconciliationSchema = z.object({
  provider: z.enum(['MULTICAIXA_EXPRESS', 'UNITEL_MONEY', 'E_KWANZA'], {
    errorMap: () => ({ message: 'Prestador inválido. Valores aceites: MULTICAIXA_EXPRESS, UNITEL_MONEY, E_KWANZA.' })
  }),
  startDate: z
    .string({ required_error: 'A data inicial é obrigatória.' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'A data inicial deve seguir o formato AAAA-MM-DD.' }),
  endDate: z
    .string({ required_error: 'A data final é obrigatória.' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'A data final deve seguir o formato AAAA-MM-DD.' })
}).superRefine((data, ctx) => {
  if (new Date(data.startDate) > new Date(data.endDate)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A data inicial não pode ser posterior à data final.',
      path: ['startDate']
    });
  }
});

// Schema de validação para resolução manual de discrepância contábil
const resolveDiscrepancySchema = z.object({
  resolutionNotes: z
    .string({ required_error: 'O parecer técnico de resolução é obrigatório.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 10, {
      message: 'O parecer técnico deve conter pelo menos 10 caracteres.'
    })
    .refine((val) => val.length <= 1000, {
      message: 'O parecer técnico não pode exceder 1000 caracteres.'
    })
});

// Schema de paginação para lista de conciliações
const listReconciliationsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20)
});

// -----------------------------------------------------------------------------
// 1. WEBHOOKS DE PRESTADORES DE PAGAMENTO (Sem sessão de utilizador / Validação HMAC)
// -----------------------------------------------------------------------------

/**
 * @route   POST /webhooks/multicaixa-express
 * @desc    Recepção de notificações assíncronas da rede Multicaixa Express (EMIS)
 * @access  Público (Validado por assinatura criptográfica HMAC-SHA256)
 */
router.post(
  '/webhooks/multicaixa-express',
  webhookController.handleMulticaixaExpress
);

/**
 * @route   POST /webhooks/unitel-money
 * @desc    Recepção de notificações assíncronas da carteira Unitel Money
 * @access  Público (Validado por assinatura criptográfica HMAC-SHA256)
 */
router.post(
  '/webhooks/unitel-money',
  webhookController.handleUnitelMoney
);

/**
 * @route   POST /webhooks/e-kwanza
 * @desc    Recepção de notificações assíncronas da plataforma e-Kwanza (BAI)
 * @access  Público (Validado por chave de API e assinatura)
 */
router.post(
  '/webhooks/e-kwanza',
  webhookController.handleEKwanza
);

/**
 * @route   POST /webhooks/:provider
 * @desc    Roteador genérico de webhooks para prestadores configurados
 * @access  Público (Validado por HMAC específico de cada prestador)
 */
router.post(
  '/webhooks/:provider',
  webhookController.handleProviderWebhook
);

// -----------------------------------------------------------------------------
// 2. CHECKOUT E PEDIDOS DE PAGAMENTO (Payment Requests)
// -----------------------------------------------------------------------------

/**
 * @route   POST /
 * @desc    Inicia um pedido de pagamento externo junto a um gateway angolano
 * @access  Privado (Membros autenticados)
 */
router.post(
  '/',
  authenticate,
  financialLimiter,
  idempotency({ required: false }),
  validateBody(initiatePaymentSchema),
  paymentsController.initiatePayment
);

/**
 * @route   POST /initiate
 * @desc    Alias para inicialização de pagamento
 * @access  Privado
 */
router.post(
  '/initiate',
  authenticate,
  financialLimiter,
  idempotency({ required: false }),
  validateBody(initiatePaymentSchema),
  paymentsController.initiatePayment
);

/**
 * @route   GET /my
 * @desc    Consulta o histórico paginado de ordens de pagamento do utilizador autenticado
 * @access  Privado
 */
router.get(
  '/my',
  authenticate,
  validateQuery(listPaymentsQuerySchema),
  paymentsController.listMyPayments
);

/**
 * @route   GET /:paymentId
 * @desc    Consulta detalhada de um pedido de pagamento por UUID (Anti-IDOR)
 * @access  Privado (Titular ou Auditores)
 */
router.get(
  '/:paymentId',
  authenticate,
  validateParams(paymentIdParamSchema),
  paymentsController.getPaymentById
);

/**
 * @route   GET /:paymentId/status
 * @desc    Consulta ativa no gateway caso haja atraso no webhook de confirmação
 * @access  Privado (Titular ou Auditores)
 */
router.get(
  '/:paymentId/status',
  authenticate,
  validateParams(paymentIdParamSchema),
  paymentsController.checkPaymentStatus
);

/**
 * @route   POST /:paymentId/cancel
 * @desc    Cancela um pedido de pagamento pendente
 * @access  Privado (Titular)
 */
router.post(
  '/:paymentId/cancel',
  authenticate,
  validateParams(paymentIdParamSchema),
  paymentsController.cancelPayment
);

// -----------------------------------------------------------------------------
// 3. CÓDIGOS QR DE COBRANÇA E PAGAMENTO (QR Codes)
// -----------------------------------------------------------------------------

/**
 * @route   POST /qr/generate
 * @desc    Gera um Código QR dinâmico para cobrança ou recebimento financeiro em AOA
 * @access  Privado
 */
router.post(
  '/qr/generate',
  authenticate,
  validateBody(generatePaymentQrSchema),
  qrController.generatePaymentQr
);

/**
 * @route   GET /qr/my
 * @desc    Consulta os Códigos QR emitidos pelo próprio utilizador autenticado
 * @access  Privado
 */
router.get(
  '/qr/my',
  authenticate,
  validateQuery(listQrTokensQuerySchema),
  qrController.listMyQrTokens
);

/**
 * @route   POST /qr/scan
 * @desc    Decodifica e resolve com segurança os metadados do token lido pelo leitor QR
 * @access  Privado
 */
router.post(
  '/qr/scan',
  authenticate,
  validateBody(scanQrTokenSchema),
  qrController.scanQrToken
);

/**
 * @route   GET /qr/scan/:tokenCode
 * @desc    Resolução de token QR via parâmetro de rota
 * @access  Privado
 */
router.get(
  '/qr/scan/:tokenCode',
  authenticate,
  validateParams(tokenCodeParamSchema),
  qrController.scanQrToken
);

/**
 * @route   POST /qr/pay
 * @desc    Liquidação e pagamento presencial debitando da carteira via Código QR
 * @access  Privado
 */
router.post(
  '/qr/pay',
  authenticate,
  financialLimiter,
  idempotency({ required: false }),
  validateBody(consumePaymentQrSchema),
  qrController.payQr
);

/**
 * @route   DELETE /qr/:qrTokenId
 * @desc    Revogação formal e imediata de um Código QR ativo
 * @access  Privado (Emissor do QR ou Administradores)
 */
router.delete(
  '/qr/:qrTokenId',
  authenticate,
  validateParams(qrTokenIdParamSchema),
  qrController.revokeQr
);

// -----------------------------------------------------------------------------
// 4. RECONCILIAÇÃO CONTÁBIL E AUDITORIA (Financial Reconciliation)
// -----------------------------------------------------------------------------

/**
 * @route   POST /reconciliation/run
 * @desc    Dispara o processo de conciliação financeira entre o razão e o prestador externo
 * @access  Privado (ADMIN, AUDITOR, FINANCIAL_OPERATOR)
 */
router.post(
  '/reconciliation/run',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR'),
  validateBody(triggerReconciliationSchema),
  async (req, res, next) => {
    try {
      const { provider, startDate, endDate } = req.body;
      const periodStart = new Date(startDate);
      periodStart.setUTCHours(0, 0, 0, 0);

      const periodEnd = new Date(endDate);
      periodEnd.setUTCHours(23, 59, 59, 999);

      const result = await reconciliationService.reconcilePeriod({
        provider: provider.toUpperCase(),
        periodStart,
        periodEnd,
        reconciledBy: req.user.id
      });

      return res.status(200).json({
        success: true,
        message: 'Lote de conciliação financeira processado com sucesso.',
        data: result.toJSON()
      });
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * @route   GET /reconciliation
 * @desc    Consulta o histórico paginado de lotes de conciliação realizados
 * @access  Privado (ADMIN, AUDITOR, FINANCIAL_OPERATOR)
 */
router.get(
  '/reconciliation',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR'),
  validateQuery(listReconciliationsQuerySchema),
  async (req, res, next) => {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const batches = await reconciliationRepository.listReconciliations({
        limit: paginationParams.limit,
        offset: paginationParams.offset
      });

      return res.status(200).json({
        success: true,
        data: batches,
        pagination: {
          currentPage: paginationParams.page,
          pageSize: paginationParams.limit
        }
      });
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * @route   GET /reconciliation/:batchReference
 * @desc    Consulta detalhada de um lote de conciliação com discrepâncias apuradas
 * @access  Privado (ADMIN, AUDITOR, FINANCIAL_OPERATOR)
 */
router.get(
  '/reconciliation/:batchReference',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR'),
  validateParams(batchReferenceParamSchema),
  async (req, res, next) => {
    try {
      const { batchReference } = req.params;
      const batch = await reconciliationRepository.findReconciliationByReference(batchReference);

      if (!batch) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'RECONCILIATION_BATCH_NOT_FOUND',
            message: `Lote de conciliação [${batchReference}] não encontrado.`
          }
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          batch
        }
      });
    } catch (error) {
      return next(error);
    }
  }
);

/**
 * @route   POST /reconciliation/:batchReference/resolve
 * @desc    Delibera e conclui a resolução manual de discrepâncias de conciliação
 * @access  Privado (ADMIN, AUDITOR)
 */
router.post(
  '/reconciliation/:batchReference/resolve',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateParams(batchReferenceParamSchema),
  validateBody(resolveDiscrepancySchema),
  async (req, res, next) => {
    try {
      const { batchReference } = req.params;
      const { resolutionNotes } = req.body;

      const batch = await reconciliationRepository.findReconciliationByReference(batchReference);
      if (!batch) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'RECONCILIATION_BATCH_NOT_FOUND',
            message: `Lote de conciliação [${batchReference}] não encontrado.`
          }
        });
      }

      const policyCheck = reconciliationPolicy.canResolveDiscrepancy(req.user, batch);
      if (!policyCheck.allowed) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'RECONCILIATION_RESOLVE_BLOCKED',
            message: policyCheck.reason
          }
        });
      }

      const resolved = await reconciliationService.resolveDiscrepancyManually({
        batchReference,
        resolvedBy: req.user.id,
        resolutionNotes
      });

      if (req.recordAudit) {
        await req.recordAudit({
          action: 'FINANCIAL_TRANSACTION',
          resourceType: 'PAYMENT_RECONCILIATION',
          resourceId: batchReference,
          metadata: {
            resolvedBy: req.user.id,
            resolutionNotes
          }
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Discrepância de conciliação resolvida e registrada com sucesso.',
        data: {
          reconciliation: resolved
        }
      });
    } catch (error) {
      return next(error);
    }
  }
);

module.exports = router;