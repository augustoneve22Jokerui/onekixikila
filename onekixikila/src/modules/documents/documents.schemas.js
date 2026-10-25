const { z } = require('zod');
const { uuidSchema } = require('../../shared/validation/common.schemas');
const { stripControlChars } = require('../../shared/security/sanitize');
const { DOCUMENT_CATEGORIES } = require('./documents.policy');

const CATEGORY_VALUES = Object.values(DOCUMENT_CATEGORIES);

/**
 * Esquema de validação para metadados de upload de documentos privados.
 */
const uploadDocumentSchema = z.object({
  category: z.enum(CATEGORY_VALUES, {
    errorMap: () => ({
      message: `Categoria de documento inválida. Valores aceites: ${CATEGORY_VALUES.join(', ')}.`
    })
  }).default(DOCUMENT_CATEGORIES.GROUP_ATTACHMENT),

  description: z
    .string()
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length <= 500, {
      message: 'A descrição do documento não pode exceder 500 caracteres.'
    })
    .optional()
    .nullable(),

  groupId: uuidSchema.optional().nullable(),

  targetUserId: uuidSchema.optional().nullable()
});

/**
 * Esquema de validação para parâmetros de rota contendo o identificador UUID do documento.
 */
const documentIdParamSchema = z.object({
  documentId: uuidSchema
});

/**
 * Esquema de validação para parâmetros de rota contendo o identificador do grupo.
 */
const groupIdParamSchema = z.object({
  groupId: uuidSchema
});

/**
 * Esquema de validação para filtros de consulta paginada de documentos privados.
 */
const listDocumentsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  category: z.enum(CATEGORY_VALUES).optional(),
  groupId: uuidSchema.optional(),
  isVerified: z
    .string()
    .transform((val) => val === 'true' || val === '1')
    .optional(),
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
 * Esquema para parecer e homologação de documento por auditores de conformidade.
 */
const verifyDocumentSchema = z.object({
  isVerified: z.boolean({ required_error: 'A decisão de validação é obrigatória (true ou false).' }),

  reviewNotes: z
    .string()
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length <= 500, {
      message: 'As notas de revisão não podem exceder 500 caracteres.'
    })
    .optional()
    .nullable()
});

module.exports = {
  uploadDocumentSchema,
  documentIdParamSchema,
  groupIdParamSchema,
  listDocumentsQuerySchema,
  verifyDocumentSchema
};