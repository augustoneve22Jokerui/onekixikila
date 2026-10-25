const { z } = require('zod');
const { uuidSchema } = require('../../shared/validation/common.schemas');
const { stripControlChars, sanitizeNationalId } = require('../../shared/security/sanitize');

// Tipos de documentos oficiais de identificação suportados
const DOCUMENT_TYPES = ['NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENSE', 'FACIAL_PHOTO', 'PROOF_OF_ADDRESS'];

// Estados de revisão de conformidade KYC
const VERIFICATION_STATUSES = ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'NEEDS_REVIEW', 'EXPIRED'];

// Níveis de verificação cadastral
const VERIFICATION_TIERS = ['TIER_1_UNVERIFIED', 'TIER_2_VERIFIED', 'TIER_3_ENHANCED'];

/**
 * Esquema de validação para submissão de processo de verificação de identidade (KYC).
 * Recolhe os dados constantes no documento oficial do cidadão para posterior conferência.
 */
const submitVerificationSchema = z.object({
  idType: z.enum(['NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENSE'], {
    errorMap: () => ({ message: "O tipo de documento deve ser 'NATIONAL_ID', 'PASSPORT' ou 'DRIVING_LICENSE'." })
  }).default('NATIONAL_ID'),

  idNumber: z
    .string({ required_error: 'O número do documento de identidade é obrigatório.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 6 && val.length <= 30, {
      message: 'O número do documento deve conter entre 6 e 30 caracteres.'
    }),

  fullNameOnDocument: z
    .string({ required_error: 'O nome completo conforme exibido no documento é obrigatório.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 3 && val.length <= 150, {
      message: 'O nome no documento deve ter entre 3 e 150 caracteres.'
    })
    .refine((val) => val.includes(' '), {
      message: 'Insira o nome completo (nome e apelido conforme o documento).'
    }),

  birthDateOnDocument: z
    .string({ required_error: 'A data de nascimento no documento é obrigatória.' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'A data de nascimento deve seguir o formato AAAA-MM-DD.' })
    .refine((val) => {
      const birth = new Date(val);
      const minAge = new Date();
      minAge.setFullYear(minAge.getFullYear() - 18);
      return birth <= minAge;
    }, { message: 'A adesão à plataforma OneKixikila exige a idade mínima comprovada de 18 anos.' }),

  expirationDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'A data de validade deve seguir o formato AAAA-MM-DD.' })
    .refine((val) => new Date(val) > new Date(), {
      message: 'O documento submetido deve estar dentro do prazo de validade.'
    })
    .optional()
    .nullable()
}).superRefine((data, ctx) => {
  // Validação específica caso o documento seja o Bilhete de Identidade Angolano
  if (data.idType === 'NATIONAL_ID') {
    const sanitizedBi = sanitizeNationalId(data.idNumber);
    if (!/^\d{9}[A-Z]{2}\d{3}$/.test(sanitizedBi)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Formato do Bilhete de Identidade angolano inválido. Padrão esperado: 9 dígitos, 2 letras e 3 dígitos (ex: 005432100LA045).',
        path: ['idNumber']
      });
    }
  }
});

/**
 * Esquema administrativo de auditoria e deliberação sobre o processo de KYC.
 */
const reviewVerificationSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'NEEDS_REVIEW'], {
    errorMap: () => ({ message: "O parecer deve ser 'APPROVED', 'REJECTED' ou 'NEEDS_REVIEW'." })
  }),

  tier: z.enum(VERIFICATION_TIERS).optional().default('TIER_2_VERIFIED'),

  rejectionReason: z
    .string()
    .trim()
    .max(500, { message: 'O motivo da rejeição não pode exceder 500 caracteres.' })
    .optional()
    .nullable(),

  reviewNotes: z
    .string()
    .trim()
    .max(1000, { message: 'As notas de revisão não podem exceder 1000 caracteres.' })
    .optional()
    .nullable()
}).superRefine((data, ctx) => {
  if (data.status === 'REJECTED' && (!data.rejectionReason || data.rejectionReason.length < 5)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A rejeição de documentos exige uma justificativa clara com pelo menos 5 caracteres.',
      path: ['rejectionReason']
    });
  }
});

/**
 * Esquema para parâmetros de consulta paginada e filtragem de processos de verificação KYC.
 */
const listVerificationsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(VERIFICATION_STATUSES).optional(),
  tier: z.enum(VERIFICATION_TIERS).optional(),
  search: z.string().trim().max(100).optional()
});

/**
 * Esquema para validação do parâmetro de rota com o identificador do processo KYC.
 */
const verificationIdParamSchema = z.object({
  verificationId: uuidSchema
});

module.exports = {
  DOCUMENT_TYPES,
  VERIFICATION_STATUSES,
  VERIFICATION_TIERS,
  submitVerificationSchema,
  reviewVerificationSchema,
  listVerificationsQuerySchema,
  verificationIdParamSchema
};