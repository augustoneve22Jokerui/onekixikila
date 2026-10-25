const { z } = require('zod');
const { uuidSchema } = require('../../shared/validation/common.schemas');
const { stripControlChars } = require('../../shared/security/sanitize');
const limitsConfig = require('../../config/limits');

// Tipos de mensagens e anexos alinhados com a migração 015
const CHAT_MESSAGE_TYPES = ['TEXT', 'AUDIO', 'DOCUMENT', 'SYSTEM_EVENT'];
const ATTACHMENT_TYPES = ['AUDIO', 'DOCUMENT', 'IMAGE'];
const REPORT_STATUSES = ['PENDING', 'REVIEWED_FLAGGED', 'REVIEWED_DISMISSED', 'ACTION_TAKEN'];

const MAX_TEXT_LENGTH = limitsConfig.chat.maxTextMessageLength || 2000;
const MAX_AUDIO_DURATION = limitsConfig.uploads.maxAudioDurationSeconds || 120;

/**
 * Esquema de validação para envio de mensagem de texto no chat do grupo.
 */
const sendTextMessageSchema = z.object({
  content: z
    .string({ required_error: 'O conteúdo da mensagem é obrigatório.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 1, { message: 'A mensagem não pode estar vazia.' })
    .refine((val) => val.length <= MAX_TEXT_LENGTH, {
      message: `A mensagem não pode exceder ${MAX_TEXT_LENGTH} caracteres.`
    }),

  clientMessageId: z
    .string()
    .trim()
    .max(64, { message: 'O clientMessageId não pode exceder 64 caracteres.' })
    .optional()
    .nullable()
});

/**
 * Esquema de validação para envio de nota de voz / áudio no chat.
 */
const sendAudioMessageSchema = z.object({
  durationSeconds: z.coerce
    .number()
    .int({ message: 'A duração do áudio deve ser um número inteiro em segundos.' })
    .min(1, { message: 'A gravação de áudio deve ter pelo menos 1 segundo.' })
    .max(MAX_AUDIO_DURATION, {
      message: `A gravação de áudio não pode exceder ${MAX_AUDIO_DURATION} segundos (2 minutos).`
    })
    .optional()
    .nullable(),

  clientMessageId: z
    .string()
    .trim()
    .max(64)
    .optional()
    .nullable()
});

/**
 * Esquema de validação para envio de documento anexo no chat (limite estrito de 5 MB tratado no Multer/backend).
 */
const sendDocumentMessageSchema = z.object({
  caption: z
    .string()
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length <= 500, { message: 'A legenda do documento não pode exceder 500 caracteres.' })
    .optional()
    .nullable(),

  clientMessageId: z
    .string()
    .trim()
    .max(64)
    .optional()
    .nullable()
});

/**
 * Esquema de validação para denúncia formal de mensagem abusiva ou imprópria.
 */
const reportMessageSchema = z.object({
  reason: z
    .string({ required_error: 'A justificativa da denúncia é obrigatória.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 5, { message: 'A justificativa deve conter pelo menos 5 caracteres.' })
    .refine((val) => val.length <= 255, { message: 'A justificativa não pode exceder 255 caracteres.' })
});

/**
 * Esquema de validação para parecer da liderança ou moderação sobre denúncia de mensagem.
 */
const resolveReportSchema = z.object({
  status: z.enum(['REVIEWED_FLAGGED', 'REVIEWED_DISMISSED', 'ACTION_TAKEN'], {
    errorMap: () => ({ message: "O estado de resolução deve ser 'REVIEWED_FLAGGED', 'REVIEWED_DISMISSED' ou 'ACTION_TAKEN'." })
  }),

  resolutionNotes: z
    .string({ required_error: 'As notas de resolução são obrigatórias.' })
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 5, { message: 'O parecer deve conter pelo menos 5 caracteres.' })
    .refine((val) => val.length <= 1000, { message: 'O parecer não pode exceder 1000 caracteres.' })
});

/**
 * Esquema de validação para consulta paginada do histórico de mensagens do grupo.
 */
const listMessagesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, { message: 'Data de corte de paginação inválida.' })
    .optional(),
  messageType: z.enum(CHAT_MESSAGE_TYPES).optional()
});

/**
 * Esquemas de validação de parâmetros de rota com UUIDs.
 */
const messageIdParamSchema = z.object({
  messageId: uuidSchema
});

const reportIdParamSchema = z.object({
  reportId: uuidSchema
});

const groupIdParamSchema = z.object({
  groupId: uuidSchema
});

module.exports = {
  CHAT_MESSAGE_TYPES,
  ATTACHMENT_TYPES,
  REPORT_STATUSES,
  sendTextMessageSchema,
  sendAudioMessageSchema,
  sendDocumentMessageSchema,
  reportMessageSchema,
  resolveReportSchema,
  listMessagesQuerySchema,
  messageIdParamSchema,
  reportIdParamSchema,
  groupIdParamSchema
};