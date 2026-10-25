const crypto = require('crypto');
const PaymentProviderContract = require('../contracts/payment-provider.contract');
const { WebhookEventDTO } = require('../contracts/webhook.contract');
const paymentsConfig = require('../../config/payments');

/**
 * Adaptador de integração para a rede Multicaixa Express (EMIS - Empresa Interbancária de Serviços).
 * Implementa o contrato PaymentProviderContract para autorização de débitos móveis,
 * QR Codes EMV e conciliação bancária em Kwanzas (AOA).
 */
class MulticaixaExpressProvider extends PaymentProviderContract {
  /**
   * @param {object} [customConfig]
   */
  constructor(customConfig = {}) {
    const config = {
      ...paymentsConfig.providers.multicaixaExpress,
      ...customConfig
    };
    super('multicaixa_express', config);
  }

  /**
   * Helper para verificar se as credenciais operacionais foram devidamente injetadas no ambiente.
   */
  ensureConfigured() {
    if (!this.config.enabled || !this.config.apiUrl) {
      throw new Error(
        '[MCX_PROVIDER] O prestador Multicaixa Express não está habilitado ou carece de credenciais válidas (API_URL, CLIENT_ID, CLIENT_SECRET).'
      );
    }
  }

  /**
   * Inicia um pedido de pagamento via Multicaixa Express para o número de telemóvel informado.
   *
   * @param {import('../contracts/payment-request.contract').PaymentRequestDTO} paymentRequest
   */
  async initiatePayment(paymentRequest) {
    this.ensureConfigured();

    const requestPayload = {
      merchant_reference: paymentRequest.merchantReference,
      amount: paymentRequest.amount,
      currency: paymentRequest.currency,
      phone_number: paymentRequest.phoneNumber,
      description: paymentRequest.description,
      timeout_seconds: Math.floor(
        (paymentRequest.expiresAt.getTime() - Date.now()) / 1000
      )
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.httpTimeoutMs || 15000);

    try {
      const response = await fetch(`${this.config.apiUrl}/payments/charge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-ID': this.config.clientId,
          'Authorization': `Bearer ${this.config.clientSecret}`,
          'X-Idempotency-Key': paymentRequest.merchantReference
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal
      });

      const responseData = await response.json();

      if (!response.ok) {
        return {
          providerTransactionId: responseData.transaction_id || `ERR-${Date.now()}`,
          status: 'FAILED',
          qrPayload: null,
          rawResponse: responseData
        };
      }

      return {
        providerTransactionId: responseData.transaction_id,
        status: responseData.status === 'COMPLETED' ? 'SUCCEEDED' : 'PENDING',
        qrPayload: responseData.qr_code || null,
        rawResponse: responseData
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('[MCX_PROVIDER] Tempo limite esgotado na comunicação com o gateway Multicaixa Express.');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Consulta o estado de um pagamento na API da rede interbancária.
   *
   * @param {string} providerTransactionId
   * @param {string} merchantReference
   */
  async checkPaymentStatus(providerTransactionId, merchantReference) {
    this.ensureConfigured();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.httpTimeoutMs || 15000);

    try {
      const response = await fetch(
        `${this.config.apiUrl}/payments/status?transaction_id=${encodeURIComponent(providerTransactionId)}&reference=${encodeURIComponent(merchantReference)}`,
        {
          method: 'GET',
          headers: {
            'X-Client-ID': this.config.clientId,
            'Authorization': `Bearer ${this.config.clientSecret}`
          },
          signal: controller.signal
        }
      );

      const responseData = await response.json();

      let mappedStatus = 'PENDING';
      if (responseData.status === 'ACCEPTED' || responseData.status === 'COMPLETED') {
        mappedStatus = 'SUCCEEDED';
      } else if (responseData.status === 'REJECTED' || responseData.status === 'FAILED') {
        mappedStatus = 'FAILED';
      } else if (responseData.status === 'EXPIRED') {
        mappedStatus = 'EXPIRED';
      }

      return {
        providerTransactionId,
        merchantReference,
        status: mappedStatus,
        amount: responseData.amount || 0,
        currency: responseData.currency || 'AOA',
        paidAt: responseData.settled_at ? new Date(responseData.settled_at) : undefined,
        rawResponse: responseData
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Valida a assinatura HMAC-SHA256 recebida no cabeçalho x-emis-signature do webhook.
   *
   * @param {object} headers
   * @param {string|Buffer} rawBody
   * @param {string} webhookSecret
   */
  verifyWebhookSignature(headers, rawBody, webhookSecret) {
    if (!webhookSecret) {
      return false;
    }

    const signature = headers['x-emis-signature'] || headers['x-signature'];
    if (!signature || typeof signature !== 'string') {
      return false;
    }

    const bodyString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);

    const calculatedHmac = crypto
      .createHmac('sha256', webhookSecret)
      .update(bodyString, 'utf8')
      .digest('hex');

    const expectedBuffer = Buffer.from(calculatedHmac, 'hex');
    const providedBuffer = Buffer.from(signature, 'hex');

    if (expectedBuffer.length !== providedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  }

  /**
   * Converte a notificação recebida da EMIS para o DTO unificado da OneKixikila.
   *
   * @param {object} headers
   * @param {object} payload
   */
  parseWebhookEvent(headers, payload) {
    const isSuccess = payload.status === 'COMPLETED' || payload.status === 'ACCEPTED';

    return WebhookEventDTO.from({
      provider: 'MULTICAIXA_EXPRESS',
      eventId: payload.event_id || payload.notification_id || `EVT-${payload.transaction_id}`,
      eventType: payload.event_type || 'PAYMENT_STATUS_UPDATE',
      merchantReference: payload.merchant_reference || payload.reference,
      providerTransactionId: String(payload.transaction_id),
      amount: Number(payload.amount),
      currency: payload.currency || 'AOA',
      status: isSuccess ? 'SUCCEEDED' : 'FAILED',
      occurredAt: payload.timestamp ? new Date(payload.timestamp) : new Date(),
      rawPayload: payload
    });
  }

  /**
   * Obtém os lançamentos do lote de conciliação para o período especificado.
   *
   * @param {Date} periodStart
   * @param {Date} periodEnd
   */
  async fetchReconciliationBatch(periodStart, periodEnd) {
    this.ensureConfigured();

    const queryParams = new URLSearchParams({
      start_date: periodStart.toISOString(),
      end_date: periodEnd.toISOString()
    });

    const response = await fetch(`${this.config.apiUrl}/reconciliation/statement?${queryParams.toString()}`, {
      method: 'GET',
      headers: {
        'X-Client-ID': this.config.clientId,
        'Authorization': `Bearer ${this.config.clientSecret}`
      }
    });

    if (!response.ok) {
      throw new Error(`[MCX_PROVIDER] Falha ao obter extrato de conciliação: HTTP ${response.status}`);
    }

    const data = await response.json();
    const items = Array.isArray(data.transactions) ? data.transactions : [];

    return items.map((item) => ({
      providerTransactionId: String(item.transaction_id),
      merchantReference: String(item.merchant_reference),
      amount: Number(item.amount),
      currency: item.currency || 'AOA',
      status: item.status === 'SETTLED' ? 'SETTLED' : 'FAILED',
      settledAt: new Date(item.settled_at || item.created_at)
    }));
  }
}

module.exports = MulticaixaExpressProvider;