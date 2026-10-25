const express = require('express');
const { z } = require('zod');
const walletController = require('../modules/wallet/wallet.controller');
const depositsController = require('../modules/deposits/deposits.controller');
const withdrawalsController = require('../modules/withdrawals/withdrawals.controller');
const transfersController = require('../modules/transfers/transfers.controller');
const payoutsController = require('../modules/payouts/payouts.controller');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const { financialLimiter } = require('../middleware/rate-limit');
const idempotency = require('../middleware/idempotency');
const {
  walletIdParamSchema,
  transactionIdParamSchema,
  getStatementQuerySchema,
  freezeWalletSchema,
  listWalletsQuerySchema
} = require('../modules/wallet/wallet.schemas');
const {
  moneyAmountSchema,
  angolanPhoneSchema,
  idempotencyKeySchema,
  uuidSchema
} = require('../shared/validation/common.schemas');
const { createParamIdSchema } = require('../shared/validation/identifiers');
const { stripControlChars } = require('../shared/security/sanitize');

const router = express.Router();

// Parâmetros de rota validados
const depositIdParamSchema = createParamIdSchema('depositId');
const withdrawalIdParamSchema = createParamIdSchema('withdrawalId');
const transferIdParamSchema = createParamIdSchema('transferId');
const payoutIdParamSchema = createParamIdSchema('payoutId');
const groupIdParamSchema = createParamIdSchema('groupId');

// Schema de validação para inicialização de depósito na carteira
const createDepositSchema = z.object({
  amount: moneyAmountSchema,
  provider: z.enum(['MULTICAIXA_EXPRESS', 'UNITEL_MONEY', 'E_KWANZA'], {
    errorMap: () => ({
      message: 'Prestador de pagamento não suportado. Prestadores aceites: MULTICAIXA_EXPRESS, UNITEL_MONEY, E_KWANZA.'
    })
  }),
  phoneNumber: angolanPhoneSchema.optional().nullable(),
  idempotencyKey: idempotencyKeySchema.optional()
});

// Schema de validação para solicitação de levantamento de fundos
const requestWithdrawalSchema = z.object({
  amount: moneyAmountSchema,
  destinationType: z.enum(
    [
      'BANK_ACCOUNT_IBAN',
      'MULTICAIXA_EXPRESS_PHONE',
      'UNITEL_MONEY_PHONE',
      'E_KWANZA_PHONE'
    ],
    {
      errorMap: () => ({
        message: 'Tipo de destino inválido. Destinos válidos: BANK_ACCOUNT_IBAN, MULTICAIXA_EXPRESS_PHONE, UNITEL_MONEY_PHONE, E_KWANZA_PHONE.'
      })
    }
  ),
  destinationAccount: z
    .string({ required_error: 'A conta de destino (IBAN ou telefone) é obrigatória.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 6 && val.length <= 100, {
      message: 'A conta de destino deve conter entre 6 e 100 caracteres.'
    }),
  destinationHolderName: z
    .string({ required_error: 'O nome do titular da conta de destino é obrigatório.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 3 && val.length <= 150, {
      message: 'O nome do titular deve conter entre 3 e 150 caracteres.'
    }),
  provider: z
    .string()
    .trim()
    .max(50)
    .default('MULTICAIXA_EXPRESS'),
  idempotencyKey: idempotencyKeySchema.optional()
});

// Schema de validação para transferência interna direta entre membros (P2P)
const transferFundsSchema = z.object({
  recipientIdentifier: z
    .string({ required_error: 'O identificador do destinatário (telefone, email ou UUID) é obrigatório.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 3, {
      message: 'Identificador do destinatário inválido.'
    }),
  amount: moneyAmountSchema,
  description: z
    .string()
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length <= 255, {
      message: 'A descrição não pode exceder 255 caracteres.'
    })
    .default('Transferência interna OneKixikila'),
  idempotencyKey: idempotencyKeySchema.optional()
});

// Schema de validação para execução de desembolso de rodada (Payout do bolo)
const executePayoutSchema = z.object({
  rotationId: uuidSchema,
  payoutMethod: z
    .enum(['INTERNAL_WALLET', 'BANK_TRANSFER'], {
      errorMap: () => ({ message: "Método de payout aceites: 'INTERNAL_WALLET' ou 'BANK_TRANSFER'." })
    })
    .default('INTERNAL_WALLET'),
  notes: z
    .string()
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length <= 255, {
      message: 'As notas não podem exceder 255 caracteres.'
    })
    .optional()
    .nullable(),
  idempotencyKey: idempotencyKeySchema.optional()
});

// Schema para justificativa de rejeição de levantamento
const rejectWithdrawalSchema = z.object({
  reason: z
    .string({ required_error: 'A justificativa de rejeição é obrigatória.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 5, {
      message: 'A justificativa deve conter no mínimo 5 caracteres.'
    })
    .refine((val) => val.length <= 255, {
      message: 'A justificativa não pode exceder 255 caracteres.'
    })
});

// Schema para justificativa de retenção de desembolso
const holdPayoutSchema = z.object({
  reason: z
    .string({ required_error: 'A justificativa de retenção cautelar é obrigatória.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 5, {
      message: 'A justificativa deve conter no mínimo 5 caracteres.'
    })
    .refine((val) => val.length <= 255, {
      message: 'A justificativa não pode exceder 255 caracteres.'
    })
});

// -----------------------------------------------------------------------------
// 1. CARTEIRA DIGITAL E SALDOS (Wallet Core)
// -----------------------------------------------------------------------------

/**
 * @route   GET /
 * @desc    Consulta os saldos e dados da carteira do próprio utilizador autenticado
 * @access  Privado
 */
router.get(
  '/',
  authenticate,
  walletController.getMyWallet
);

/**
 * @route   GET /me
 * @desc    Alias para consulta da carteira própria
 * @access  Privado
 */
router.get(
  '/me',
  authenticate,
  walletController.getMyWallet
);

/**
 * @route   GET /admin/all
 * @desc    Lista as carteiras da plataforma para supervisão e auditoria
 * @access  Privado (ADMIN, AUDITOR, FINANCIAL_OPERATOR)
 */
router.get(
  '/admin/all',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR'),
  validateQuery(listWalletsQuerySchema),
  walletController.listWallets
);

/**
 * @route   GET /receipts/:transactionId
 * @desc    Consulta o comprovativo oficial estruturado de uma operação contábil
 * @access  Privado (Titular ou Auditores)
 */
router.get(
  '/receipts/:transactionId',
  authenticate,
  validateParams(transactionIdParamSchema),
  walletController.getReceipt
);

/**
 * @route   GET /:walletId
 * @desc    Consulta os dados de uma carteira por UUID (Anti-IDOR)
 * @access  Privado (Titular ou Auditores)
 */
router.get(
  '/:walletId',
  authenticate,
  validateParams(walletIdParamSchema),
  walletController.getWalletById
);

/**
 * @route   GET /:walletId/statement
 * @desc    Consulta o extrato financeiro unificado da carteira com paginação e filtros
 * @access  Privado (Titular ou Auditores)
 */
router.get(
  '/:walletId/statement',
  authenticate,
  validateParams(walletIdParamSchema),
  validateQuery(getStatementQuerySchema),
  walletController.getStatement
);

/**
 * @route   PATCH /:walletId/freeze
 * @desc    Congela preventivamente a carteira por motivo de litígio ou auditoria
 * @access  Privado (ADMIN, AUDITOR)
 */
router.patch(
  '/:walletId/freeze',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateParams(walletIdParamSchema),
  validateBody(freezeWalletSchema),
  walletController.freezeWallet
);

/**
 * @route   PATCH /:walletId/unfreeze
 * @desc    Descongela a carteira restabelecendo as operações normais de saldo
 * @access  Privado (ADMIN, AUDITOR)
 */
router.patch(
  '/:walletId/unfreeze',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  validateParams(walletIdParamSchema),
  walletController.unfreezeWallet
);

// -----------------------------------------------------------------------------
// 2. DEPÓSITOS (Deposits)
// -----------------------------------------------------------------------------

/**
 * @route   POST /deposits
 * @desc    Inicia um pedido de depósito na carteira interna via gateway angolano
 * @access  Privado
 */
router.post(
  '/deposits',
  authenticate,
  financialLimiter,
  idempotency({ required: false }),
  validateBody(createDepositSchema),
  depositsController.createDeposit
);

/**
 * @route   GET /deposits
 * @desc    Consulta o histórico paginado de depósitos do utilizador autenticado
 * @access  Privado
 */
router.get(
  '/deposits',
  authenticate,
  depositsController.listMyDeposits
);

/**
 * @route   GET /deposits/:depositId
 * @desc    Consulta detalhada de um depósito por UUID
 * @access  Privado (Titular ou Auditores)
 */
router.get(
  '/deposits/:depositId',
  authenticate,
  validateParams(depositIdParamSchema),
  depositsController.getDepositById
);

/**
 * @route   POST /deposits/:depositId/cancel
 * @desc    Cancela uma intenção de depósito pendente antes da liquidação bancária
 * @access  Privado (Titular)
 */
router.post(
  '/deposits/:depositId/cancel',
  authenticate,
  validateParams(depositIdParamSchema),
  depositsController.cancelDeposit
);

// -----------------------------------------------------------------------------
// 3. LEVANTAMENTOS (Withdrawals)
// -----------------------------------------------------------------------------

/**
 * @route   POST /withdrawals
 * @desc    Solicita um levantamento de fundos com reserva cautelar de saldo
 * @access  Privado (Exige KYC verificado)
 */
router.post(
  '/withdrawals',
  authenticate,
  financialLimiter,
  idempotency({ required: false }),
  validateBody(requestWithdrawalSchema),
  withdrawalsController.requestWithdrawal
);

/**
 * @route   GET /withdrawals
 * @desc    Consulta o histórico paginado de levantamentos do utilizador
 * @access  Privado
 */
router.get(
  '/withdrawals',
  authenticate,
  withdrawalsController.listMyWithdrawals
);

/**
 * @route   GET /withdrawals/admin/all
 * @desc    Lista a fila geral de levantamentos da plataforma para a tesouraria
 * @access  Privado (ADMIN, AUDITOR, FINANCIAL_OPERATOR)
 */
router.get(
  '/withdrawals/admin/all',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR'),
  withdrawalsController.listAllWithdrawals
);

/**
 * @route   GET /withdrawals/:withdrawalId
 * @desc    Consulta detalhada de uma ordem de levantamento por UUID
 * @access  Privado (Titular ou Auditores)
 */
router.get(
  '/withdrawals/:withdrawalId',
  authenticate,
  validateParams(withdrawalIdParamSchema),
  withdrawalsController.getWithdrawalById
);

/**
 * @route   POST /withdrawals/:withdrawalId/cancel
 * @desc    Cancela um levantamento pendente, libertando os fundos reservados
 * @access  Privado (Titular)
 */
router.post(
  '/withdrawals/:withdrawalId/cancel',
  authenticate,
  validateParams(withdrawalIdParamSchema),
  withdrawalsController.cancelWithdrawal
);

/**
 * @route   POST /withdrawals/:withdrawalId/approve
 * @desc    Aprova e liquida um levantamento com lançamento no livro-razão
 * @access  Privado (ADMIN, FINANCIAL_OPERATOR)
 */
router.post(
  '/withdrawals/:withdrawalId/approve',
  authenticate,
  authorize('ADMIN', 'FINANCIAL_OPERATOR'),
  validateParams(withdrawalIdParamSchema),
  withdrawalsController.approveWithdrawal
);

/**
 * @route   POST /withdrawals/:withdrawalId/reject
 * @desc    Rejeita um levantamento e reverte os fundos reservados para o saldo disponível
 * @access  Privado (ADMIN, FINANCIAL_OPERATOR)
 */
router.post(
  '/withdrawals/:withdrawalId/reject',
  authenticate,
  authorize('ADMIN', 'FINANCIAL_OPERATOR'),
  validateParams(withdrawalIdParamSchema),
  validateBody(rejectWithdrawalSchema),
  withdrawalsController.rejectWithdrawal
);

// -----------------------------------------------------------------------------
// 4. TRANSFERÊNCIAS INTERNAS (P2P Transfers)
// -----------------------------------------------------------------------------

/**
 * @route   POST /transfers
 * @desc    Executa uma transferência direta entre membros com dupla partida contábil
 * @access  Privado
 */
router.post(
  '/transfers',
  authenticate,
  financialLimiter,
  idempotency({ required: false }),
  validateBody(transferFundsSchema),
  transfersController.transferFunds
);

/**
 * @route   GET /transfers/sent
 * @desc    Consulta o histórico de transferências enviadas pelo utilizador
 * @access  Privado
 */
router.get(
  '/transfers/sent',
  authenticate,
  transfersController.listMySentTransfers
);

/**
 * @route   GET /transfers/received
 * @desc    Consulta o histórico de transferências recebidas pelo utilizador
 * @access  Privado
 */
router.get(
  '/transfers/received',
  authenticate,
  transfersController.listMyReceivedTransfers
);

/**
 * @route   GET /transfers/:transferId
 * @desc    Consulta o comprovativo de uma transferência interna por UUID
 * @access  Privado (Remetente, Destinatário ou Auditores)
 */
router.get(
  '/transfers/:transferId',
  authenticate,
  validateParams(transferIdParamSchema),
  transfersController.getTransferById
);

// -----------------------------------------------------------------------------
// 5. DESEMBOLSOS DE ROTAÇÃO (Payouts de Kixikila)
// -----------------------------------------------------------------------------

/**
 * @route   POST /payouts/execute
 * @desc    Executa a entrega do bolo da Kixikila ao beneficiário do turno ativo
 * @access  Privado (Líder do grupo ou Operador Financeiro)
 */
router.post(
  '/payouts/execute',
  authenticate,
  idempotency({ required: false }),
  validateBody(executePayoutSchema),
  payoutsController.executePayout
);

/**
 * @route   GET /payouts/my
 * @desc    Consulta os bolos de Kixikila recebidos pelo utilizador em todos os grupos
 * @access  Privado
 */
router.get(
  '/payouts/my',
  authenticate,
  payoutsController.listMyPayouts
);

/**
 * @route   GET /payouts/group/:groupId
 * @desc    Lista o histórico de desembolsos realizados num grupo específico
 * @access  Privado (Membros do grupo ou Auditores)
 */
router.get(
  '/payouts/group/:groupId',
  authenticate,
  validateParams(groupIdParamSchema),
  payoutsController.listGroupPayouts
);

/**
 * @route   GET /payouts/:payoutId
 * @desc    Consulta detalhada de um desembolso por UUID
 * @access  Privado (Beneficiário, Líder ou Auditores)
 */
router.get(
  '/payouts/:payoutId',
  authenticate,
  validateParams(payoutIdParamSchema),
  payoutsController.getPayoutById
);

/**
 * @route   POST /payouts/:payoutId/hold
 * @desc    Retém preventivamente um desembolso em caso de litígio ou disputa
 * @access  Privado (Líder do grupo ou Auditores)
 */
router.post(
  '/payouts/:payoutId/hold',
  authenticate,
  validateParams(payoutIdParamSchema),
  validateBody(holdPayoutSchema),
  payoutsController.holdPayout
);

/**
 * @route   POST /payouts/:payoutId/release
 * @desc    Liberta um desembolso retido de volta para a esteira de liquidação
 * @access  Privado (Líder do grupo ou Auditores)
 */
router.post(
  '/payouts/:payoutId/release',
  authenticate,
  validateParams(payoutIdParamSchema),
  payoutsController.releasePayout
);

module.exports = router;