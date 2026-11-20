const { z } = require('zod');
const { uuidSchema } = require('../../shared/validation/common.schemas');
const { stripControlChars } = require('../../shared/security/sanitize');
const { WALLET_STATUSES } = require('../../shared/constants/statuses');

// Operações contábeis que afetam a carteira digital (alinhadas com a migração 010)
const FINANCIAL_OPERATION_TYPES = [
  'DEPOSIT',
  'WITHDRAWAL',
  'INTERNAL_TRANSFER',
  'CONTRIBUTION_PAYMENT',
  'ROTATION_PAYOUT',
  'PLATFORM_FEE',
  'LATE_PENALTY',
  'REFUND_REVERSAL',
  'DISPUTE_HOLD',
  'DISPUTE_RELEASE'
];

/**
 * Esquema de validação para parâmetros de rota contendo o identificador UUID da carteira.
 */
const walletIdParamSchema = z.object({
  walletId: uuidSchema
});

/**
 * Esquema de validação para parâmetros de rota contendo o identificador UUID da transação contábil.
 */
const transactionIdParamSchema = z.object({
  transactionId: uuidSchema
});

/**
 * Esquema de validação para consulta e filtragem do extrato da carteira.
 */
const getStatementQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  operationType: z.enum(FINANCIAL_OPERATION_TYPES).optional(),
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
 * Esquema de validação para congelamento administrativo da carteira.
 */
const freezeWalletSchema = z.object({
  reason: z
    .string({ required_error: 'A justificativa para o congelamento da carteira é obrigatória.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 5, { message: 'A justificativa deve conter pelo menos 5 caracteres.' })
    .refine((val) => val.length <= 255, { message: 'A justificativa não pode exceder 255 caracteres.' })
});

/**
 * Esquema de validação para listagem e supervisão de carteiras no painel administrativo.
 */
const listWalletsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(Object.values(WALLET_STATUSES)).optional(),
  hasBalance: z
    .string()
    .transform((val) => val === 'true' || val === '1')
    .optional()
});

module.exports = {
  FINANCIAL_OPERATION_TYPES,
  walletIdParamSchema,
  transactionIdParamSchema,
  getStatementQuerySchema,
  freezeWalletSchema,
  listWalletsQuerySchema
};