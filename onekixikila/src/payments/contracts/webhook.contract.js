const { z } = require('zod');

// Schema de validação para a notificação de webhook padronizada da plataforma
const webhookEventSchema = z.object({
  provider: z.enum(['MULTICAIXA_EXPRESS', 'UNITEL_MONEY', 'E_KWANZA'], {
    errorMap: () => ({ message: 'Identificador do prestador inválido ou não suportado.' })
  }),

  eventId: z
    .string()
    .min(1, 'eventId é obrigatório para garantir idempotência contra duplicidade.')
    .max(150, 'eventId não pode exceder 150 caracteres.'),

  eventType: z
    .string()
    .min(1, 'eventType é obrigatório.')
    .max(100, 'eventType não pode exceder 100 caracteres.'),

  merchantReference: z
    .string()
    .min(6, 'merchantReference deve conter pelo menos 6 caracteres.')
    .max(64, 'merchantReference não pode exceder 64 caracteres.'),

  providerTransactionId: z
    .string()
    .min(1, 'providerTransactionId é obrigatório.')
    .max(150, 'providerTransactionId não pode exceder 150 caracteres.'),

  amount: z
    .number()
    .int('O montante liquidado deve ser um número inteiro de Kwanzas.')
    .positive('O montante deve ser estritamente positivo.'),

  currency: z
    .string()
    .length(3, 'Código de moeda deve ter 3 caracteres.')
    .default('AOA'),

  status: z.enum(['SUCCEEDED', 'FAILED', 'REFUNDED'], {
    errorMap: () => ({ message: 'Status do evento de webhook inválido.' })
  }),

  occurredAt: z.date().default(() => new Date()),

  rawPayload: z.record(z.any())
});

/**
 * Objeto de Transferência de Dados (DTO) para eventos canónicos de Webhook.
 * Padroniza os formatos divergentes dos gateways de Angola num único contrato seguro.
 */
class WebhookEventDTO {
  /**
   * Constrói e valida a representação imutável do evento de webhook.
   * @param {object} rawData
   */
  constructor(rawData) {
    const validated = webhookEventSchema.parse(rawData);

    this.provider = validated.provider;
    this.eventId = validated.eventId;
    this.eventType = validated.eventType;
    this.merchantReference = validated.merchantReference;
    this.providerTransactionId = validated.providerTransactionId;
    this.amount = validated.amount;
    this.currency = validated.currency;
    this.status = validated.status;
    this.occurredAt = validated.occurredAt;
    this.rawPayload = Object.freeze({ ...validated.rawPayload });

    Object.freeze(this);
  }

  /**
   * Instancia um evento a partir de dados brutos pós-validação.
   * @param {object} rawData
   * @returns {WebhookEventDTO}
   */
  static from(rawData) {
    return new WebhookEventDTO(rawData);
  }

  /**
   * Serializa o evento para registo em auditoria e base de dados.
   * @returns {object}
   */
  toJSON() {
    return {
      provider: this.provider,
      eventId: this.eventId,
      eventType: this.eventType,
      merchantReference: this.merchantReference,
      providerTransactionId: this.providerTransactionId,
      amount: this.amount,
      currency: this.currency,
      status: this.status,
      occurredAt: this.occurredAt.toISOString(),
      rawPayload: this.rawPayload
    };
  }
}

module.exports = {
  webhookEventSchema,
  WebhookEventDTO
};