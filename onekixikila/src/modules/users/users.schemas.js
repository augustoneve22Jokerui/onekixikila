const { z } = require('zod');
const { ALL_USER_ROLES } = require('../../shared/constants/roles');
const { USER_STATUSES } = require('../../shared/constants/statuses');
const { ALL_CURRENCY_CODES } = require('../../shared/constants/currencies');
const { stripControlChars } = require('../../shared/security/sanitize');

/**
 * Esquema de validação para atualização do perfil pessoal do utilizador.
 * Permite alteração de nome preferencial, província, município, bairro e dados biográficos.
 */
const updateProfileSchema = z.object({
  fullName: z
    .string()
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 3, { message: 'O nome completo deve conter pelo menos 3 caracteres.' })
    .refine((val) => val.length <= 150, { message: 'O nome completo não pode exceder 150 caracteres.' })
    .refine((val) => val.includes(' '), { message: 'Insira o nome completo (nome e apelido).' })
    .optional(),

  preferredName: z
    .string()
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 2, { message: 'O nome preferencial deve ter pelo menos 2 caracteres.' })
    .refine((val) => val.length <= 100, { message: 'O nome preferencial não pode exceder 100 caracteres.' })
    .optional(),

  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Data de nascimento deve seguir o formato AAAA-MM-DD.' })
    .refine((val) => {
      const birth = new Date(val);
      const minAgeDate = new Date();
      minAgeDate.setFullYear(minAgeDate.getFullYear() - 18);
      return birth <= minAgeDate;
    }, { message: 'A adesão à plataforma OneKixikila exige a idade mínima de 18 anos.' })
    .optional(),

  gender: z
    .enum(['MASCULINO', 'FEMININO', 'OUTRO', 'PREFIRO_NAO_DIZER'], {
      errorMap: () => ({ message: 'Selecione uma opção de género válida.' })
    })
    .optional(),

  province: z
    .string()
    .trim()
    .max(100, { message: 'Província não pode exceder 100 caracteres.' })
    .optional(),

  municipality: z
    .string()
    .trim()
    .max(100, { message: 'Município não pode exceder 100 caracteres.' })
    .optional(),

  neighborhood: z
    .string()
    .trim()
    .max(150, { message: 'Bairro não pode exceder 150 caracteres.' })
    .optional(),

  addressLine: z
    .string()
    .trim()
    .max(255, { message: 'Endereço não pode exceder 255 caracteres.' })
    .optional(),

  bio: z
    .string()
    .trim()
    .max(300, { message: 'A biografia não pode exceder 300 caracteres.' })
    .optional(),

  avatarUrl: z
    .string()
    .url({ message: 'URL do avatar inválido.' })
    .max(500, { message: 'URL do avatar excede 500 caracteres.' })
    .optional()
    .nullable()
});

/**
 * Esquema de validação para consentimento e atualização de coordenadas geográficas
 * para a funcionalidade de descoberta de grupos de Kixikila próximos.
 */
const updateLocationSchema = z.object({
  latitude: z
    .coerce.number()
    .min(-90, { message: 'Latitude mínima é -90.' })
    .max(90, { message: 'Latitude máxima é 90.' }),

  longitude: z
    .coerce.number()
    .min(-180, { message: 'Longitude mínima é -180.' })
    .max(180, { message: 'Longitude máxima é 180.' }),

  province: z
    .string()
    .trim()
    .max(100)
    .optional(),

  municipality: z
    .string()
    .trim()
    .max(100)
    .optional(),

  neighborhood: z
    .string()
    .trim()
    .max(150)
    .optional(),

  locationAuthorized: z
    .boolean({ required_error: 'Confirmação de autorização de localização obrigatória.' })
});

/**
 * Esquema de validação para preferências de notificações e idioma.
 */
const updatePreferencesSchema = z.object({
  preferredLocale: z
    .enum(['pt-AO', 'en-US'], {
      errorMap: () => ({ message: "Idioma suportado: 'pt-AO' ou 'en-US'." })
    })
    .default('pt-AO'),

  preferredCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .refine((val) => ALL_CURRENCY_CODES.includes(val), {
      message: 'Moeda não suportada na plataforma.'
    })
    .default('AOA'),

  notificationPreferences: z
    .object({
      email: z.boolean().default(true),
      sms: z.boolean().default(true),
      inApp: z.boolean().default(true)
    })
    .optional()
});

/**
 * Esquema administrativo para alteração de função global de utilizador (RBAC).
 */
const updateUserRoleSchema = z.object({
  role: z.enum(ALL_USER_ROLES, {
    errorMap: () => ({ message: 'Papel de utilizador inválido ou não autorizado.' })
  })
});

/**
 * Esquema administrativo para alteração de estado operacional de utilizador (bloqueios e suspensões).
 */
const updateUserStatusSchema = z.object({
  status: z.enum(Object.values(USER_STATUSES), {
    errorMap: () => ({ message: 'Estado de utilizador inválido.' })
  }),

  reason: z
    .string({ required_error: 'A justificativa para a alteração de estado é obrigatória.' })
    .trim()
    .min(5, { message: 'A justificativa deve conter pelo menos 5 caracteres.' })
    .max(255, { message: 'A justificativa não pode exceder 255 caracteres.' })
});

/**
 * Esquema para filtros de listagem e pesquisa administrativa de utilizadores.
 */
const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().trim().max(100).optional(),
  role: z.enum(ALL_USER_ROLES).optional(),
  status: z.enum(Object.values(USER_STATUSES)).optional(),
  province: z.string().trim().max(100).optional(),
  municipality: z.string().trim().max(100).optional()
});

module.exports = {
  updateProfileSchema,
  updateLocationSchema,
  updatePreferencesSchema,
  updateUserRoleSchema,
  updateUserStatusSchema,
  listUsersQuerySchema
};