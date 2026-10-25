const { z } = require('zod');
const { uuidSchema, angolanPhoneSchema, idempotencyKeySchema } = require('../../shared/validation/common.schemas');
const { stripControlChars } = require('../../shared/security/sanitize');

// Métodos de pagamento autorizados para liquidação de quotas de Kixikila
const PAYMENT_METHODS = ['INTERNAL_WALLET', 'MULTICAIXA_EXPRESS', 'UNITEL_MONEY', 'E_KWANZA'];

// Estados canónicos de liquidação de contribuições
const CONTRIBUTION_STATUSES = ['INITIATED', 'PROCESSING', 'CONFIRMED', 'FAILED', 'REFUNDED'];

/**
 * Esquema de validação para pagamento / liquidação de uma quota de Kixikila.
 * Permite pagamento imediato debitando da carteira interna ou geração de cobrança direta via gateway externo.
 */
const payContributionSchema = z.object({
  obligationId: uuidSchema,

  paymentMethod: z.enum(PAYMENT_METHODS, {
    errorMap: () => ({ message: `Método de pagamento não suportado. Métodos aceites: ${PAYMENT_METHODS.join(', ')}.` })
  }).default('INTERNAL_WALLET'),

  idempotencyKey: idempotencyKeySchema.optional(),

  phoneNumber: angolanPhoneSchema.optional().nullable(),

  notes: z
    .string()
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length <= 255, { message: 'As notas não podem exceder 255 caracteres.' })
    .optional()
    .nullable()
}).superRefine((data, ctx) => {
  // Se o método for débito móvel (Multicaixa Express ou Unitel Money), o telefone é obrigatório caso não herdado do utilizador
  if ((data.paymentMethod === 'MULTICAIXA_EXPRESS' || data.paymentMethod === 'UNITEL_MONEY') && data.phoneNumber === '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'O número de telemóvel angolano é obrigatório para débitos móveis.',
      path: ['phoneNumber']
    });
  }
});

/**
 * Esquema de validação para consulta e filtragem paginada de contribuições.
 */
const listContributionsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  groupId: uuidSchema.optional(),
  status: z.enum(CONTRIBUTION_STATUSES).optional(),
  cycleNumber: z.coerce.number().int().positive().optional(),
  roundNumber: z.coerce.number().int().positive().optional()
});

/**
 * Esquema para dispensa ou perdão de multa de mora por decisão da liderança.
 */
const waiveLateFeeSchema = z.object({
  reason: z
    .string({ required_error: 'A justificativa para a dispensa da multa é obrigatória.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 5, { message: 'A justificativa deve conter pelo menos 5 caracteres.' })
    .refine((val) => val.length <= 255, { message: 'A justificativa não pode exceder 255 caracteres.' })
});

/**
 * Esquema para validação do identificador da contribuição em parâmetros de rota.
 */
const contributionIdParamSchema = z.object({
  contributionId: uuidSchema
});

/**
 * Esquema para validação do identificador de obrigação em parâmetros de rota.
 */
const obligationIdParamSchema = z.object({
  obligationId: uuidSchema
});

module.exports = {
  PAYMENT_METHODS,
  CONTRIBUTION_STATUSES,
  payContributionSchema,
  listContributionsQuerySchema,
  waiveLateFeeSchema,
  contributionIdParamSchema,
  obligationIdParamSchema
};