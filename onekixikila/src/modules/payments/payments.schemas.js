const { z } = require('zod');
const { uuidSchema, angolanPhoneSchema, moneyAmountSchema } = require('../../shared/validation/common.schemas');
const { stripControlChars } = require('../../shared/security/sanitize');

// Prestadores autorizados para intermediação de pagamentos em Angola
const PAYMENT_PROVIDERS = ['MULTICAIXA_EXPRESS', 'UNITEL_MONEY', 'E_KWANZA'];

// Canais autorizados de checkout
const PAYMENT_CHANNELS = ['MOBILE', 'QR_CODE', 'USSD', 'WEB'];

// Estados canónicos de pedidos de pagamento
const PAYMENT_STATUSES = ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED'];

/**
 * Esquema de validação para inicialização de um pedido de pagamento externo.
 */
const initiatePaymentSchema = z.object({
  provider: z.enum(PAYMENT_PROVIDERS, {
    errorMap: () => ({ message: `Prestador de pagamento inválido. Valores aceites: ${PAYMENT_PROVIDERS.join(', ')}.` })
  }),

  channel: z.enum(PAYMENT_CHANNELS).default('MOBILE'),

  amount: moneyAmountSchema,

  phoneNumber: angolanPhoneSchema.optional().nullable(),

  description: z
    .string()
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length <= 255, { message: 'A descrição não pode exceder 255 caracteres.' })
    .default('Pagamento OneKixikila'),

  groupId: uuidSchema.optional().nullable(),
  contributionId: uuidSchema.optional().nullable(),
  depositId: uuidSchema.optional().nullable(),

  idempotencyKey: z
    .string()
    .trim()
    .min(8)
    .max(120)
    .optional()
}).superRefine((data, ctx) => {
  // Para débitos móveis via Multicaixa Express ou Unitel Money no canal MOBILE, o telefone é obrigatório caso informado
  if ((data.provider === 'MULTICAIXA_EXPRESS' || data.provider === 'UNITEL_MONEY') && data.channel === 'MOBILE') {
    if (data.phoneNumber === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'O número de telemóvel angolano é obrigatório para débitos móveis.',
        path: ['phoneNumber']
      });
    }
  }
});

/**
 * Esquema de validação para parâmetros de rota com o identificador do pagamento (UUID).
 */
const paymentIdParamSchema = z.object({
  paymentId: uuidSchema
});

/**
 * Esquema de validação para filtros de consulta paginada de ordens de pagamento.
 */
const listPaymentsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(PAYMENT_STATUSES).optional(),
  provider: z.enum(PAYMENT_PROVIDERS).optional()
});

module.exports = {
  PAYMENT_PROVIDERS,
  PAYMENT_CHANNELS,
  PAYMENT_STATUSES,
  initiatePaymentSchema,
  paymentIdParamSchema,
  listPaymentsQuerySchema
};