// =============================================================================
// modules/invitations/invitations.schemas.js
// =============================================================================

const { z } = require('zod');
const { uuidSchema, emailSchema, angolanPhoneSchema } = require('../../shared/validation/common.schemas');
const { stripControlChars } = require('../../shared/security/sanitize');

const INVITATION_CHANNELS = ['DIRECT_LINK', 'QR_CODE', 'SMS', 'EMAIL', 'MANUAL_CODE'];

const INVITATION_STATUSES = ['PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED'];

/**
 * Esquema de validação para geração de um novo convite seguro para grupo de Kixikila.
 */
const createInvitationSchema = z
  .object({
    channel: z
      .enum(INVITATION_CHANNELS, {
        errorMap: () => ({
          message: `Canal de convite inválido. Canais aceites: ${INVITATION_CHANNELS.join(', ')}.`
        })
      })
      .default('DIRECT_LINK'),

    invitedPhone: angolanPhoneSchema.optional().nullable(),

    invitedEmail: emailSchema.optional().nullable(),

    invitedUserId: uuidSchema.optional().nullable(),

    maxUses: z.coerce
      .number()
      .int({ message: 'O número máximo de utilizações deve ser um inteiro.' })
      .min(1, { message: 'O convite deve permitir pelo menos 1 utilização.' })
      .max(50, { message: 'O número máximo de utilizações por convite é 50.' })
      .default(1),

    expiresInDays: z.coerce
      .number()
      .int({ message: 'O prazo de validade em dias deve ser um inteiro.' })
      .min(1, { message: 'O prazo mínimo de validade é de 1 dia.' })
      .max(30, { message: 'O prazo máximo de validade do convite é de 30 dias.' })
      .default(7)
  })
  .superRefine((data, ctx) => {
    if (data.channel === 'SMS' && !data.invitedPhone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'O número de telemóvel angolano (invitedPhone) é obrigatório para convites via SMS.',
        path: ['invitedPhone']
      });
    }

    if (data.channel === 'EMAIL' && !data.invitedEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'O endereço de e-mail (invitedEmail) é obrigatório para convites via E-mail.',
        path: ['invitedEmail']
      });
    }
  });

/**
 * Esquema de validação para aceitação de convite por código alfanumérico ou QR Code.
 * `inviteCode` é opcional no body porque pode vir da query string (`?code=...`)
 * nos alias `/join` e `/join/accept`.
 */
const acceptInvitationSchema = z.object({
  inviteCode: z
    .string()
    .transform((val) => stripControlChars(val).trim())
    .refine((val) => val.length >= 6 && val.length <= 64, {
      message: 'Código de convite deve ter entre 6 e 64 caracteres.'
    })
    .refine((val) => /^[A-Za-z0-9_\-]+$/.test(val), {
      message: 'Código de convite contém caracteres inválidos.'
    })
    .optional()
});

const listInvitationsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(INVITATION_STATUSES).optional(),
  channel: z.enum(INVITATION_CHANNELS).optional()
});

const invitationIdParamSchema = z.object({
  invitationId: uuidSchema
});

const inviteCodeParamSchema = z.object({
  inviteCode: z
    .string()
    .trim()
    .min(6)
    .max(64)
    .regex(/^[A-Za-z0-9_\-]+$/)
});

module.exports = {
  INVITATION_CHANNELS,
  INVITATION_STATUSES,
  createInvitationSchema,
  acceptInvitationSchema,
  listInvitationsQuerySchema,
  invitationIdParamSchema,
  inviteCodeParamSchema
};