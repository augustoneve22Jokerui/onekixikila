const { z } = require('zod');

// Schema formal de validação para pedidos de pagamento enviados aos prestadores
const paymentRequestSchema = z.object({
  merchantReference: z
    .string()
    .min(6, 'merchantReference deve conter pelo menos 6 caracteres.')
    .max(64, 'merchantReference não pode exceder 64 caracteres.')
    .regex(/^[A-Za-z0-9_-]+$/, 'merchantReference deve ser alfanumérico com hifens ou underscores.'),

  amount: z
    .number()
    .int('Montante de pagamento deve ser um número inteiro de Kwanzas.')
    .positive('Montante deve ser estritamente superior a zero.')
    .min(100, 'Montante mínimo de pagamento é de 100 Kz.'),

  currency: z
    .string()
    .length(3, 'Código de moeda deve possuir 3 caracteres.')
    .default('AOA'),

  phoneNumber: z
    .string()
    .regex(/^(?:\+244|244)?(9[1-9]\d{7})$/, 'Número de telefone deve estar no formato nacional angolano (+244 9xx xxx xxx).')
    .optional()
    .nullable(),

  provider: z.enum(['MULTICAIXA_EXPRESS', 'UNITEL_MONEY', 'E_KWANZA'], {
    errorMap: () => ({ message: 'Prestador de pagamento não suportado pela plataforma.' })
  }),

  channel: z
    .enum(['MOBILE', 'QR_CODE', 'USSD', 'WEB'])
    .default('MOBILE'),

  description: z
    .string()
    .max(255, 'Descrição não pode exceder 255 caracteres.')
    .default('Pagamento OneKixikila'),

  userId: z.string().uuid('userId deve ser um UUID v4 válido.'),
  walletId: z.string().uuid('walletId deve ser um UUID v4 válido.'),

  groupId: z.string().uuid('groupId deve ser um UUID válido.').optional().nullable(),
  contributionId: z.string().uuid('contributionId deve ser um UUID válido.').optional().nullable(),
  depositId: z.string().uuid('depositId deve ser um UUID válido.').optional().nullable(),

  expiresAt: z
    .date()
    .refine((date) => date.getTime() > Date.now(), 'Data de expiração do pagamento deve ser no futuro.')
    .default(() => new Date(Date.now() + 15 * 60 * 1000)), // 15 minutos por padrão

  metadata: z.record(z.any()).default({})
});

/**
 * Objeto de Transferência de Dados (DTO) imutável para orquestração de pedidos de pagamento.
 */
class PaymentRequestDTO {
  /**
   * Constrói e valida uma instância imutável do pedido de pagamento.
   * @param {object} rawData
   */
  constructor(rawData) {
    const validated = paymentRequestSchema.parse(rawData);

    this.merchantReference = validated.merchantReference;
    this.amount = validated.amount;
    this.currency = validated.currency;
    this.phoneNumber = validated.phoneNumber || null;
    this.provider = validated.provider;
    this.channel = validated.channel;
    this.description = validated.description;
    this.userId = validated.userId;
    this.walletId = validated.walletId;
    this.groupId = validated.groupId || null;
    this.contributionId = validated.contributionId || null;
    this.depositId = validated.depositId || null;
    this.expiresAt = validated.expiresAt;
    this.metadata = Object.freeze({ ...validated.metadata });

    Object.freeze(this);
  }

  /**
   * Cria uma instância validada a partir de dados brutos.
   * @param {object} rawData
   * @returns {PaymentRequestDTO}
   */
  static from(rawData) {
    return new PaymentRequestDTO(rawData);
  }

  /**
   * Serializa o pedido para persistência ou transmissão.
   * @returns {object}
   */
  toJSON() {
    return {
      merchantReference: this.merchantReference,
      amount: this.amount,
      currency: this.currency,
      phoneNumber: this.phoneNumber,
      provider: this.provider,
      channel: this.channel,
      description: this.description,
      userId: this.userId,
      walletId: this.walletId,
      groupId: this.groupId,
      contributionId: this.contributionId,
      depositId: this.depositId,
      expiresAt: this.expiresAt.toISOString(),
      metadata: this.metadata
    };
  }
}

module.exports = {
  paymentRequestSchema,
  PaymentRequestDTO
};