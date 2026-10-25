const { z } = require('zod');
const { uuidSchema, slugSchema } = require('./common.schemas');
const ValidationError = require('../errors/validation-error');

/**
 * Cria um esquema Zod para validação de parâmetro de rota contendo um identificador UUID v4.
 *
 * @param {string} [paramName='id'] - Nome do parâmetro na rota (ex: 'groupId', 'userId', 'walletId')
 * @returns {import('zod').ZodObject}
 */
const createParamIdSchema = (paramName = 'id') => {
  return z.object({
    [paramName]: uuidSchema
  });
};

/**
 * Cria um esquema Zod para validação de parâmetro de rota baseado em slug textual.
 *
 * @param {string} [paramName='slug']
 * @returns {import('zod').ZodObject}
 */
const createSlugParamSchema = (paramName = 'slug') => {
  return z.object({
    [paramName]: slugSchema
  });
};

// Esquemas específicos pré-configurados para os parâmetros de rotas mais frequentes
const userIdParamSchema = createParamIdSchema('userId');
const groupIdParamSchema = createParamIdSchema('groupId');
const membershipIdParamSchema = createParamIdSchema('membershipId');
const walletIdParamSchema = createParamIdSchema('walletId');
const transactionIdParamSchema = createParamIdSchema('transactionId');
const messageIdParamSchema = createParamIdSchema('messageId');
const documentIdParamSchema = createParamIdSchema('documentId');
const disputeIdParamSchema = createParamIdSchema('disputeId');
const scheduleIdParamSchema = createParamIdSchema('scheduleId');
const groupSlugParamSchema = createSlugParamSchema('slug');

/**
 * Esquema de validação para referências de transação de pagamento e liquidação.
 * Padrão alfanumérico estruturado (ex: 'DEP-20261024-ABC123XY', 'MCX-987654321').
 */
const referenceNumberSchema = z
  .string({ required_error: 'A referência de transação é obrigatória.' })
  .trim()
  .min(6, { message: 'A referência deve conter no mínimo 6 caracteres.' })
  .max(64, { message: 'A referência não pode exceder 64 caracteres.' })
  .regex(/^[A-Za-z0-9_\-:]+$/, {
    message: 'A referência deve conter apenas caracteres alfanuméricos, hifens, underscores e dois-pontos.'
  });

/**
 * Esquema de validação para códigos de convite de grupos de Kixikila.
 */
const inviteCodeSchema = z
  .string({ required_error: 'O código de convite é obrigatório.' })
  .trim()
  .min(6, { message: 'O código de convite deve ter no mínimo 6 caracteres.' })
  .max(64, { message: 'O código de convite não pode exceder 64 caracteres.' })
  .regex(/^[A-Za-z0-9_\-]+$/, {
    message: 'O código de convite deve conter apenas caracteres alfanuméricos seguros.'
  });

/**
 * Esquema para tokens dinâmicos de Códigos QR (pagamento ou convite presencial).
 */
const qrTokenCodeSchema = z
  .string({ required_error: 'O token QR é obrigatório.' })
  .trim()
  .min(16, { message: 'O token QR deve conter pelo menos 16 caracteres.' })
  .max(128, { message: 'O token QR não pode exceder 128 caracteres.' });

/**
 * Esquema para códigos de verificação numérica (OTP).
 */
const verificationOtpSchema = z
  .string({ required_error: 'O código de verificação é obrigatório.' })
  .trim()
  .regex(/^\d{4,8}$/, {
    message: 'O código de verificação deve ser composto por 4 a 8 dígitos numéricos.'
  });

/**
 * Validador síncrono utilitário para checagem rápida de UUID.
 *
 * @param {string} id - Valor a testar
 * @param {string} [fieldName='id']
 * @returns {string} UUID validado
 * @throws {ValidationError}
 */
const validateUuid = (id, fieldName = 'id') => {
  const result = uuidSchema.safeParse(id);
  if (!result.success) {
    throw ValidationError.invalidFormat(fieldName, 'UUID v4 válido');
  }
  return result.data;
};

/**
 * Validador síncrono utilitário para checagem rápida de slug.
 *
 * @param {string} slug
 * @param {string} [fieldName='slug']
 * @returns {string} Slug validado
 * @throws {ValidationError}
 */
const validateSlug = (slug, fieldName = 'slug') => {
  const result = slugSchema.safeParse(slug);
  if (!result.success) {
    throw ValidationError.invalidFormat(fieldName, 'slug alfanumérico com hifens (ex: kixikila-talatona)');
  }
  return result.data;
};

module.exports = {
  createParamIdSchema,
  createSlugParamSchema,
  userIdParamSchema,
  groupIdParamSchema,
  membershipIdParamSchema,
  walletIdParamSchema,
  transactionIdParamSchema,
  messageIdParamSchema,
  documentIdParamSchema,
  disputeIdParamSchema,
  scheduleIdParamSchema,
  groupSlugParamSchema,
  referenceNumberSchema,
  inviteCodeSchema,
  qrTokenCodeSchema,
  verificationOtpSchema,
  validateUuid,
  validateSlug
};