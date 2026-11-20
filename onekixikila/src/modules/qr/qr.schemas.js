const { z } = require('zod');
const {
  uuidSchema,
  moneyAmountSchema,
  idempotencyKeySchema
} = require('../../shared/validation/common.schemas');
const { stripControlChars } = require('../../shared/security/sanitize');

// Tipos de Códigos QR homologados na plataforma (alinhados com a migração 013)
const QR_TYPES = ['GROUP_INVITE', 'PAYMENT_RECEIVE', 'DIRECT_TRANSFER', 'DEVICE_LINK'];

// Estados canónicos de um token QR
const QR_STATUSES = ['ACTIVE', 'USED', 'EXPIRED', 'REVOKED'];

/**
 * Esquema de validação para emissão de Código QR de convite a grupo de Kixikila.
 */
const generateGroupInviteQrSchema = z.object({
  groupId: uuidSchema.optional(),

  maxScans: z.coerce
    .number()
    .int({ message: 'O número máximo de escaneamentos deve ser um inteiro.' })
    .min(1, { message: 'Deve permitir no mínimo 1 escaneamento.' })
    .max(100, { message: 'O número máximo de escaneamentos por convite é 100.' })
    .default(10),

  expiresInMinutes: z.coerce
    .number()
    .int({ message: 'A validade em minutos deve ser um número inteiro.' })
    .min(15, { message: 'Validade mínima de 15 minutos.' })
    .max(43200, { message: 'Validade máxima de 30 dias (43.200 minutos).' })
    .default(10080) // 7 dias por padrão
});

/**
 * Esquema de validação para emissão de Código QR dinâmico de cobrança ou recebimento financeiro.
 */
const generatePaymentQrSchema = z.object({
  fixedAmount: moneyAmountSchema.optional().nullable(),

  maxScans: z.coerce
    .number()
    .int({ message: 'O número máximo de escaneamentos deve ser um inteiro.' })
    .min(1, { message: 'Deve permitir no mínimo 1 escaneamento.' })
    .max(50, { message: 'Máximo de 50 escaneamentos por QR de cobrança.' })
    .default(1),

  expiresInMinutes: z.coerce
    .number()
    .int({ message: 'A validade em minutos deve ser um inteiro.' })
    .min(5, { message: 'Validade mínima de 5 minutos.' })
    .max(1440, { message: 'Validade máxima de 24 horas (1.440 minutos).' })
    .default(15),

  description: z
    .string()
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length <= 255, { message: 'A descrição não pode exceder 255 caracteres.' })
    .default('Cobrança via QR Code OneKixikila')
});

/**
 * Esquema de validação para leitura ou escaneamento de um token QR.
 */
const scanQrTokenSchema = z.object({
  tokenCode: z
    .string({ required_error: 'O código do token QR é obrigatório.' })
    .trim()
    .min(8, { message: 'Código de token QR muito curto.' })
    .max(128, { message: 'Código de token QR excede o tamanho esperado.' })
    .regex(/^[A-Za-z0-9_\-]+$/, { message: 'Código de token QR contém caracteres inválidos.' })
});

/**
 * Esquema de validação para liquidação e consumo de um Código QR de pagamento.
 */
const consumePaymentQrSchema = z.object({
  tokenCode: z
    .string({ required_error: 'O código do token QR é obrigatório.' })
    .trim()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9_\-]+$/),

  amount: moneyAmountSchema.optional().nullable(),

  idempotencyKey: idempotencyKeySchema.optional(),

  description: z
    .string()
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length <= 255, { message: 'A descrição não pode exceder 255 caracteres.' })
    .optional()
});

/**
 * Esquema de validação para parâmetros de rota contendo o identificador UUID do token QR.
 */
const qrTokenIdParamSchema = z.object({
  qrTokenId: uuidSchema
});

/**
 * Esquema de validação para parâmetros de rota contendo o código textual do token QR.
 */
const tokenCodeParamSchema = z.object({
  tokenCode: z
    .string()
    .trim()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9_\-]+$/)
});

/**
 * Esquema de validação para filtros de consulta paginada de Códigos QR gerados.
 */
const listQrTokensQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  qrType: z.enum(QR_TYPES).optional(),
  status: z.enum(QR_STATUSES).optional()
});

module.exports = {
  QR_TYPES,
  QR_STATUSES,
  generateGroupInviteQrSchema,
  generatePaymentQrSchema,
  scanQrTokenSchema,
  consumePaymentQrSchema,
  qrTokenIdParamSchema,
  tokenCodeParamSchema,
  listQrTokensQuerySchema
};