/**
 * Contrato abstrato que define a interface obrigatória para todos os adaptadores
 * de prestadores de pagamento integrados à plataforma OneKixikila (Multicaixa Express, Unitel Money, e-Kwanza).
 *
 * Qualquer novo adaptador deve estender esta classe e implementar todos os métodos.
 */
class PaymentProviderContract {
  /**
   * @param {string} providerId - Identificador único do prestador (ex: 'multicaixa_express', 'unitel_money')
   * @param {object} config - Configurações de API, credenciais e parâmetros operacionais
   */
  constructor(providerId, config = {}) {
    if (new.target === PaymentProviderContract) {
      throw new TypeError('PaymentProviderContract é uma classe abstrata e não pode ser instanciada diretamente.');
    }
    this.providerId = providerId;
    this.config = Object.freeze({ ...config });
  }

  /**
   * Inicia um pedido de cobrança/pagamento junto ao prestador externo.
   *
   * @param {object} paymentRequest - Dados da requisição
   * @param {string} paymentRequest.merchantReference - Referência única da OneKixikila
   * @param {number} paymentRequest.amount - Montante inteiro em Kwanzas (AOA)
   * @param {string} paymentRequest.currency - Código ISO da moeda (AOA)
   * @param {string} paymentRequest.phoneNumber - Número de telemóvel do cliente (formato angolano)
   * @param {string} paymentRequest.description - Descrição descritiva do pagamento
   * @param {Date} paymentRequest.expiresAt - Data limite de validade do pedido
   * @returns {Promise<{
   *   providerTransactionId: string,
   *   status: string,
   *   qrPayload?: string,
   *   rawResponse: object
   * }>}
   */
  async initiatePayment(paymentRequest) {
    throw new Error(`[${this.providerId}] O método initiatePayment() deve ser implementado pelo adaptador.`);
  }

  /**
   * Consulta ativamente o estado atualizado de uma transação junto ao gateway.
   *
   * @param {string} providerTransactionId - Identificador retornado pelo prestador
   * @param {string} merchantReference - Referência interna da plataforma
   * @returns {Promise<{
   *   providerTransactionId: string,
   *   merchantReference: string,
   *   status: 'PENDING'|'PROCESSING'|'SUCCEEDED'|'FAILED'|'EXPIRED',
   *   amount: number,
   *   currency: string,
   *   paidAt?: Date,
   *   rawResponse: object
   * }>}
   */
  async checkPaymentStatus(providerTransactionId, merchantReference) {
    throw new Error(`[${this.providerId}] O método checkPaymentStatus() deve ser implementado pelo adaptador.`);
  }

  /**
   * Valida a assinatura criptográfica (HMAC/SHA) de notificações recebidas via webhook.
   *
   * @param {object} headers - Cabeçalhos HTTP recebidos
   * @param {string|Buffer} rawBody - Corpo bruto da requisição
   * @param {string} webhookSecret - Segredo de assinatura configurado
   * @returns {boolean}
   */
  verifyWebhookSignature(headers, rawBody, webhookSecret) {
    throw new Error(`[${this.providerId}] O método verifyWebhookSignature() deve ser implementado pelo adaptador.`);
  }

  /**
   * Converte a notificação bruta do webhook num formato canónico padronizado da plataforma.
   *
   * @param {object} headers - Cabeçalhos HTTP
   * @param {object} payload - Corpo parseado da requisição
   * @returns {{
   *   eventId: string,
   *   eventType: string,
   *   merchantReference: string,
   *   providerTransactionId: string,
   *   amount: number,
   *   currency: string,
   *   status: 'SUCCEEDED'|'FAILED'|'REFUNDED',
   *   occurredAt: Date,
   *   rawPayload: object
   * }}
   */
  parseWebhookEvent(headers, payload) {
    throw new Error(`[${this.providerId}] O método parseWebhookEvent() deve ser implementado pelo adaptador.`);
  }

  /**
   * Solicita o estorno ou reembolso de um pagamento previamente liquidado.
   *
   * @param {object} refundRequest
   * @param {string} refundRequest.merchantReference - Referência do pedido original
   * @param {string} refundRequest.providerTransactionId - ID original do prestador
   * @param {number} refundRequest.amount - Montante a reembolsar em Kwanzas
   * @param {string} refundRequest.reason - Motivo formal do estorno
   * @returns {Promise<{
   *   refundTransactionId: string,
   *   status: 'PROCESSING'|'SUCCEEDED'|'FAILED',
   *   rawResponse: object
   * }>}
   */
  async requestRefund(refundRequest) {
    throw new Error(`[${this.providerId}] O método requestRefund() não é suportado ou não foi implementado pelo adaptador.`);
  }

  /**
   * Obtém o extrato do lote de transações para conciliação contábil em determinado período.
   *
   * @param {Date} periodStart
   * @param {Date} periodEnd
   * @returns {Promise<Array<{
   *   providerTransactionId: string,
   *   merchantReference: string,
   *   amount: number,
   *   currency: string,
   *   status: string,
   *   settledAt: Date
   * }>>}
   */
  async fetchReconciliationBatch(periodStart, periodEnd) {
    throw new Error(`[${this.providerId}] O método fetchReconciliationBatch() deve ser implementado pelo adaptador.`);
  }
}

module.exports = PaymentProviderContract;