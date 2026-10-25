const { z } = require('zod');
const {
  emailSchema,
  angolanPhoneSchema,
  passwordSchema,
  uuidSchema
} = require('../../shared/validation/common.schemas');
const { stripControlChars, sanitizePhoneNumber } = require('../../shared/security/sanitize');

/**
 * Esquema de validação para o registo de novas contas de utilizador na OneKixikila.
 * Recolhe nome completo, número de telemóvel angolano, e-mail, palavra-passe forte
 * e consentimento explícito dos termos de serviço.
 */
const registerSchema = z.object({
  fullName: z
    .string({ required_error: 'O nome completo é obrigatório.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 3, { message: 'O nome completo deve conter pelo menos 3 caracteres.' })
    .refine((val) => val.length <= 150, { message: 'O nome completo não pode exceder 150 caracteres.' })
    .refine((val) => val.includes(' '), {
      message: 'Insira o nome completo (nome e apelido).'
    }),

  phoneNumber: angolanPhoneSchema,

  email: emailSchema,

  password: passwordSchema,

  alternatePhone: z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((val) => (val ? sanitizePhoneNumber(val) : null)),

  termsAccepted: z
    .boolean({ required_error: 'A aceitação dos termos e políticas é obrigatória.' })
    .refine((val) => val === true, {
      message: 'Deverá aceitar expressamente os Termos de Serviço e a Política de Privacidade.'
    })
});

/**
 * Esquema de validação para autenticação / início de sessão (Login).
 * Permite autenticação por endereço de e-mail ou número de telemóvel nacional angolano.
 */
const loginSchema = z.object({
  identifier: z
    .string({ required_error: 'E-mail ou número de telefone é obrigatório.' })
    .trim()
    .refine((val) => val.length > 0, { message: 'Credencial de identificação não pode estar vazia.' }),

  password: z
    .string({ required_error: 'A palavra-passe é obrigatória.' })
    .min(1, { message: 'A palavra-passe é obrigatória.' }),

  deviceFingerprint: z
    .string()
    .trim()
    .max(255)
    .optional()
    .default(() => 'unknown-device'),

  deviceName: z
    .string()
    .trim()
    .max(150)
    .optional()
    .default('Navegador Web'),

  deviceType: z
    .enum(['MOBILE', 'DESKTOP', 'TABLET', 'OTHER'])
    .optional()
    .default('OTHER')
});

/**
 * Esquema de validação para verificação de contas via código numérico OTP (SMS ou E-mail).
 */
const verifyOtpSchema = z.object({
  type: z.enum(['PHONE', 'EMAIL'], {
    errorMap: () => ({ message: "O canal de verificação deve ser 'PHONE' ou 'EMAIL'." })
  }),

  code: z
    .string({ required_error: 'O código de verificação OTP é obrigatório.' })
    .trim()
    .regex(/^\d{4,8}$/, {
      message: 'O código de verificação deve conter entre 4 e 8 dígitos numéricos.'
    }),

  userId: uuidSchema.optional()
});

/**
 * Esquema de validação para novo envio de código de confirmação (Resend OTP).
 */
const resendOtpSchema = z.object({
  type: z.enum(['PHONE', 'EMAIL'], {
    errorMap: () => ({ message: "O tipo de canal deve ser 'PHONE' ou 'EMAIL'." })
  }),

  identifier: z
    .string({ required_error: 'Identificador (e-mail ou telefone) é obrigatório.' })
    .trim()
    .min(3, { message: 'Identificador inválido.' })
});

/**
 * Esquema de validação para solicitação de recuperação de conta / esquecimento de senha.
 */
const forgotPasswordSchema = z.object({
  identifier: z
    .string({ required_error: 'Forneça o e-mail ou o número de telefone associado à conta.' })
    .trim()
    .min(3, { message: 'Identificador inválido.' })
});

/**
 * Esquema de validação para redefinição de palavra-passe com token seguro.
 */
const resetPasswordSchema = z.object({
  token: z
    .string({ required_error: 'O token de redefinição é obrigatório.' })
    .trim()
    .min(16, { message: 'Token de redefinição inválido ou truncado.' })
    .max(128, { message: 'Token de redefinição excede o tamanho esperado.' }),

  newPassword: passwordSchema
});

/**
 * Esquema de validação para alteração de palavra-passe por utilizador já autenticado.
 */
const changePasswordSchema = z
  .object({
    currentPassword: z
      .string({ required_error: 'A palavra-passe atual é obrigatória.' })
      .min(1, { message: 'A palavra-passe atual é obrigatória.' }),

    newPassword: passwordSchema
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'A nova palavra-passe deve ser diferente da palavra-passe atual.',
    path: ['newPassword']
  });

/**
 * Esquema para renovação de sessão via Refresh Token.
 */
const refreshTokenSchema = z.object({
  refreshToken: z
    .string({ required_error: 'O Refresh Token é obrigatório.' })
    .trim()
    .min(32, { message: 'Refresh Token mal formado ou inválido.' })
});

module.exports = {
  registerSchema,
  loginSchema,
  verifyOtpSchema,
  resendOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  refreshTokenSchema
};