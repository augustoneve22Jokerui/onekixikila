const { z } = require('zod');
const limitsConfig = require('../../config/limits');
const { uuidSchema, slugSchema } = require('../../shared/validation/common.schemas');
const { stripControlChars } = require('../../shared/security/sanitize');

// Frequências operacionais de contribuição da Kixikila
const ALLOWED_FREQUENCIES = limitsConfig.groups.allowedFrequencies; // ['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY']

// Tipos de ordenação e deliberação de rotação da mão
const ROTATION_TYPES = ['FIXED', 'AUCTION', 'RANDOM_DRAW', 'CONSENSUS'];

// Tipos de taxas de mora por incumprimento de prazo
const LATE_FEE_TYPES = ['FIXED', 'PERCENTAGE', 'NONE'];

// Estados do ciclo de vida de grupos
const GROUP_STATUSES = ['DRAFT', 'FORMATION', 'ACTIVE', 'PAUSED', 'COMPLETED', 'SUSPENDED', 'CANCELLED'];

/**
 * Esquema de validação para criação de um novo grupo de Kixikila.
 * Abrange parâmetros financeiros, ciclo de rotação, regulamento e localização para descoberta.
 */
const createGroupSchema = z.object({
  name: z
    .string({ required_error: 'O nome do grupo de Kixikila é obrigatório.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 3, { message: 'O nome do grupo deve ter pelo menos 3 caracteres.' })
    .refine((val) => val.length <= 150, { message: 'O nome do grupo não pode exceder 150 caracteres.' }),

  description: z
    .string()
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length <= 1000, { message: 'A descrição não pode exceder 1000 caracteres.' })
    .optional()
    .nullable(),

  frequency: z.enum(ALLOWED_FREQUENCIES, {
    errorMap: () => ({ message: `Frequência inválida. Valores aceites: ${ALLOWED_FREQUENCIES.join(', ')}.` })
  }),

  contributionAmount: z.coerce
    .number({ required_error: 'O valor da quota de contribuição é obrigatório.' })
    .int({ message: 'O valor da quota deve ser um número inteiro de Kwanzas (AOA).' })
    .min(limitsConfig.groups.minContributionAmount, {
      message: `A quota mínima permitida por membro é de ${limitsConfig.groups.minContributionAmount.toLocaleString('pt-AO')} Kz.`
    })
    .max(limitsConfig.groups.maxContributionAmount, {
      message: `A quota máxima permitida é de ${limitsConfig.groups.maxContributionAmount.toLocaleString('pt-AO')} Kz.`
    }),

  minMembers: z.coerce
    .number()
    .int({ message: 'A quantidade mínima de membros deve ser um inteiro.' })
    .min(limitsConfig.groups.minMembers, {
      message: `O grupo deve ter no mínimo ${limitsConfig.groups.minMembers} participantes.`
    })
    .max(limitsConfig.groups.maxMembers)
    .default(limitsConfig.groups.minMembers),

  maxMembers: z.coerce
    .number()
    .int({ message: 'A quantidade máxima de membros deve ser um inteiro.' })
    .min(limitsConfig.groups.minMembers)
    .max(limitsConfig.groups.maxMembers, {
      message: `O grupo não pode exceder ${limitsConfig.groups.maxMembers} participantes.`
    })
    .default(12),

  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'A data de início deve seguir o formato AAAA-MM-DD.' })
    .refine((val) => new Date(val) >= new Date(new Date().setHours(0, 0, 0, 0)), {
      message: 'A data de início da Kixikila não pode ser no passado.'
    })
    .optional()
    .nullable(),

  isPrivate: z.boolean().default(false),

  allowAutoDebit: z.boolean().default(false),

  // Regras operacionais do grupo (group_rules)
  rules: z.object({
    rotationType: z.enum(ROTATION_TYPES, {
      errorMap: () => ({ message: 'Tipo de rotação inválido.' })
    }).default('FIXED'),

    gracePeriodDays: z.coerce
      .number()
      .int()
      .min(0, { message: 'O período de carência não pode ser negativo.' })
      .max(15, { message: 'O período de carência não pode exceder 15 dias.' })
      .default(limitsConfig.groups.defaultGracePeriodDays),

    lateFeeType: z.enum(LATE_FEE_TYPES).default('FIXED'),

    lateFeeValue: z.coerce
      .number()
      .int()
      .min(0, { message: 'A penalização de mora não pode ser negativa.' })
      .default(0),

    allowEarlyPayout: z.boolean().default(false),

    requireAdminApprovalToJoin: z.boolean().default(true),

    requireIdentityVerification: z.boolean().default(true),

    termsAndConditions: z
      .string()
      .max(5000, { message: 'O regulamento interno não pode exceder 5000 caracteres.' })
      .optional()
      .nullable()
  }).default({}),

  // Localização geográfica aproximada para descoberta pública (group_locations)
  location: z.object({
    province: z
      .string({ required_error: 'A província de localização do grupo é obrigatória.' })
      .trim()
      .min(2, { message: 'Província inválida.' })
      .max(100),

    municipality: z
      .string({ required_error: 'O município de localização do grupo é obrigatório.' })
      .trim()
      .min(2, { message: 'Município inválido.' })
      .max(100),

    neighborhood: z
      .string()
      .trim()
      .max(150)
      .optional()
      .nullable(),

    approximateLatitude: z.coerce
      .number()
      .min(-90)
      .max(90)
      .optional()
      .nullable(),

    approximateLongitude: z.coerce
      .number()
      .min(-180)
      .max(180)
      .optional()
      .nullable(),

    radiusMeters: z.coerce
      .number()
      .int()
      .min(500)
      .max(50000)
      .default(5000),

    isPubliclyDiscoverable: z.boolean().default(true)
  }).optional()
}).superRefine((data, ctx) => {
  if (data.minMembers > data.maxMembers) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'A quantidade mínima de membros não pode ser superior à quantidade máxima.',
      path: ['minMembers']
    });
  }
});

/**
 * Esquema de validação para edição cadastral do grupo de Kixikila.
 */
const updateGroupSchema = z.object({
  name: z
    .string()
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 3, { message: 'O nome do grupo deve ter pelo menos 3 caracteres.' })
    .refine((val) => val.length <= 150, { message: 'O nome não pode exceder 150 caracteres.' })
    .optional(),

  description: z
    .string()
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length <= 1000, { message: 'A descrição não pode exceder 1000 caracteres.' })
    .optional()
    .nullable(),

  isPrivate: z.boolean().optional(),

  allowAutoDebit: z.boolean().optional()
});

/**
 * Esquema de validação para atualização do regulamento interno do grupo.
 */
const updateGroupRulesSchema = z.object({
  rotationType: z.enum(ROTATION_TYPES).optional(),

  gracePeriodDays: z.coerce
    .number()
    .int()
    .min(0)
    .max(15)
    .optional(),

  lateFeeType: z.enum(LATE_FEE_TYPES).optional(),

  lateFeeValue: z.coerce
    .number()
    .int()
    .min(0)
    .optional(),

  allowEarlyPayout: z.boolean().optional(),

  requireAdminApprovalToJoin: z.boolean().optional(),

  requireIdentityVerification: z.boolean().optional(),

  termsAndConditions: z
    .string()
    .max(5000)
    .optional()
    .nullable()
});

/**
 * Esquema de validação para atualização da localização geográfica aproximada do grupo.
 */
const updateGroupLocationSchema = z.object({
  province: z.string().trim().min(2).max(100),
  municipality: z.string().trim().min(2).max(100),
  neighborhood: z.string().trim().max(150).optional().nullable(),
  approximateLatitude: z.coerce.number().min(-90).max(90).optional().nullable(),
  approximateLongitude: z.coerce.number().min(-180).max(180).optional().nullable(),
  radiusMeters: z.coerce.number().int().min(500).max(50000).default(5000),
  isPubliclyDiscoverable: z.boolean().default(true)
});

/**
 * Esquema de validação para filtros de pesquisa e descoberta de grupos de Kixikila.
 */
const listGroupsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().trim().max(100).optional(),
  frequency: z.enum(ALLOWED_FREQUENCIES).optional(),
  minAmount: z.coerce.number().int().positive().optional(),
  maxAmount: z.coerce.number().int().positive().optional(),
  province: z.string().trim().max(100).optional(),
  municipality: z.string().trim().max(100).optional(),
  status: z.enum(GROUP_STATUSES).optional(),
  isPrivate: z
    .string()
    .transform((val) => val === 'true' || val === '1')
    .optional()
});

/**
 * Esquema de validação para busca de grupos próximos por geolocalização (raio esférico).
 */
const nearbyGroupsQuerySchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  radiusMeters: z.coerce.number().int().min(1000).max(50000).default(10000),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20)
});

/**
 * Esquemas para validação de identificador de grupo (UUID ou Slug).
 */
const groupIdParamSchema = z.object({
  groupId: uuidSchema
});

const groupSlugParamSchema = z.object({
  slug: slugSchema
});

module.exports = {
  ALLOWED_FREQUENCIES,
  ROTATION_TYPES,
  LATE_FEE_TYPES,
  GROUP_STATUSES,
  createGroupSchema,
  updateGroupSchema,
  updateGroupRulesSchema,
  updateGroupLocationSchema,
  listGroupsQuerySchema,
  nearbyGroupsQuerySchema,
  groupIdParamSchema,
  groupSlugParamSchema
};