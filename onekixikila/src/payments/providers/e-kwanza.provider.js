const crypto = require('crypto');
const PaymentProviderContract = require('../contracts/payment-provider.contract');
const { WebhookEventDTO } = require('../contracts/webhook.contract');
const paymentsConfig = require('../../config/payments');

/**
 * Adaptador de integração para o serviço e-Kwanza (Banco BAI / ecossistema digital angolano).
 * Implementa o contrato PaymentProviderContract para autorização de débitos em contas digitais,
 * leitura de QR Codes e conciliação de quotas em Kwanzas (AOA).
 */
class EKwanzaProvider extends PaymentProviderContract {
  /**
   * @param {object} [customConfig]
   */
  constructor(customConfig = {}) {
    const config = {
      ...paymentsConfig.providers.eKwanza,
      ...customConfig
    };
    super('e_kwanza', config);
  }

  /**
   * Verifica se as credenciais do e-Kwanza estão devidamente configuradas no ambiente.
   */
  ensureConfigured() {
    if (!this.config.enabled || !this.config.apiUrl || !this.config.apiKey) {
      throw new Error(
        '[E_KWANZA_PROVIDER] O prestador e-Kwanza não está habilitado ou carece de credenciais operacionais válidas (API_URL, API_KEY).'
      );
    }
  }

  /**
   * Inicia um pedido de cobrança na carteira/conta e-Kwanza.
   *
   * @param {import('../contracts/payment-request.contract').PaymentRequestDTO} paymentRequest
   */
  async initiatePayment(paymentRequest) {
    this.ensureConfigured();

    const requestPayload = {
      order_id: paymentRequest.merchantReference,
      amount: paymentRequest.amount,
      currency: paymentRequest.currency,
      customer_phone: paymentRequest.phoneNumber,
      service_description: paymentRequest.description,
      expiration_timestamp: paymentRequest.expiresAt.toISOString()
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.httpTimeoutMs || 15000);

    try {
      const response = await fetch(`${this.config.apiUrl}/payments/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.config.apiKey,
          'X-Request-Reference': paymentRequest.merchantReference
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal
      });

      const responseData = await response.json();

      if (!response.ok) {
        return {
          providerTransactionId: responseData.ekwanza_reference || `ERR-EK-${Date.now()}`,
          status: 'FAILED',
          qrPayload: null,
          rawResponse: responseData
        };
      }

      return {
        providerTransactionId: responseData.ekwanza_reference,
        status: responseData.payment_status === 'SETTLED' ? 'SUCCEEDED' : 'PENDING',
        qrPayload: responseData.qr_code_data || null,
        rawResponse: responseData
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('[E_KWANZA_PROVIDER] Tempo limite esgotado na comunicação com o gateway e-Kwanza.');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Consulta o estado de uma ordem de pagamento no e-Kwanza.
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
        `${this.config.apiUrl}/payments/orders/${encodeURIComponent(providerTransactionId)}?order_id=${encodeURIComponent(merchantReference)}`,
        {
          method: 'GET',
          headers: {
            'X-API-Key': this.config.apiKey
          },
          signal: controller.signal
        }
      );

      const responseData = await response.json();

      let mappedStatus = 'PENDING';
      if (responseData.status === 'SUCCESS' || responseData.status === 'SETTLED') {
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
        amount: responseData.total_amount || 0,
        currency: responseData.currency || 'AOA',
        paidAt: responseData.completed_at ? new Date(responseData.completed_at) : undefined,
        rawResponse: responseData
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Valida a assinatura de notificações no cabeçalho x-ekwanza-signature.
   *
   * @param {object} headers
   * @param {string|Buffer} rawBody
   * @param {string} webhookSecret
   */
  verifyWebhookSignature(headers, rawBody, webhookSecret) {
    if (!webhookSecret) {
      return false;
    }

    const signature = headers['x-ekwanza-signature'] || headers['x-signature'];
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
   * Transforma a notificação do e-Kwanza no DTO canónico de webhook.
   *
   * @param {object} headers
   * @param {object} payload
   */
  parseWebhookEvent(headers, payload) {
    const isSuccess = payload.status === 'SUCCESS' || payload.status === 'SETTLED';

    return WebhookEventDTO.from({
      provider: 'E_KWANZA',
      eventId: payload.event_identifier || `EK-${payload.ekwanza_reference}`,
      eventType: payload.action || 'PAYMENT_CONFIRMATION',
      merchantReference: payload.order_id || payload.reference,
      providerTransactionId: String(payload.ekwanza_reference),
      amount: Number(payload.amount),
      currency: payload.currency || 'AOA',
      status: isSuccess ? 'SUCCEEDED' : 'FAILED',
      occurredAt: payload.settled_at ? new Date(payload.settled_at) : new Date(),
      rawPayload: payload
    });
  }

  /**
   * Submete um pedido de estorno de liquidação no e-Kwanza.
   *
   * @param {object} refundRequest
   */
  async requestRefund(refundRequest) {
    this.ensureConfigured();

    const response = await fetch(`${this.config.apiUrl}/payments/reverse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.config.apiKey
      },
      body: JSON.stringify({
        ekwanza_reference: refundRequest.providerTransactionId,
        order_id: refundRequest.merchantReference,
        reversal_amount: refundRequest.amount,
        justification: refundRequest.reason
      })
    });

    const data = await response.json();

    return {
      refundTransactionId: data.reversal_reference || `REV-EK-${Date.now()}`,
      status: data.status === 'CONFIRMED' ? 'SUCCEEDED' : 'PROCESSING',
      rawResponse: data
    };
  }

  /**
   * Descarrega o extrato de liquidações para auditoria contábil.
   *
   * @param {Date} periodStart
   * @param {Date} periodEnd
   */
  async fetchReconciliationBatch(periodStart, periodEnd) {
    this.ensureConfigured();

    const queryParams = new URLSearchParams({
      start: periodStart.toISOString(),
      end: periodEnd.toISOString()
    });

    const response = await fetch(`${this.config.apiUrl}/reports/clearing?${queryParams.toString()}`, {
      method: 'GET',
      headers: {
        'X-API-Key': this.config.apiKey
      }
    });

    if (!response.ok) {
      throw new Error(`[E_KWANZA_PROVIDER] Falha ao consultar lote de conciliação: HTTP ${response.status}`);
    }

    const data = await response.json();
    const records = Array.isArray(data.transactions) ? data.transactions : [];

    return records.map((t) => ({
      providerTransactionId: String(t.ekwanza_reference),
      merchantReference: String(t.order_id),
      amount: Number(t.amount),
      currency: t.currency || 'AOA',
      status: t.status === 'SETTLED' ? 'SETTLED' : 'FAILED',
      settledAt: new Date(t.settled_at)
    }));
  }
}

module.exports = EKwanzaProvider;