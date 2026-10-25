const crypto = require('crypto');
const PaymentProviderContract = require('../contracts/payment-provider.contract');
const { WebhookEventDTO } = require('../contracts/webhook.contract');
const paymentsConfig = require('../../config/payments');

/**
 * Adaptador de integração para a carteira móvel Unitel Money (Angola).
 * Implementa o contrato PaymentProviderContract para débitos móveis via push USSD,
 * liquidação em carteiras digitais e reconciliação em Kwanzas (AOA).
 */
class UnitelMoneyProvider extends PaymentProviderContract {
  /**
   * @param {object} [customConfig]
   */
  constructor(customConfig = {}) {
    const config = {
      ...paymentsConfig.providers.unitelMoney,
      ...customConfig
    };
    super('unitel_money', config);
  }

  /**
   * Valida se o prestador Unitel Money está devidamente configurado no ambiente.
   */
  ensureConfigured() {
    if (!this.config.enabled || !this.config.apiUrl) {
      throw new Error(
        '[UNITEL_MONEY_PROVIDER] O prestador Unitel Money não está habilitado ou carece de credenciais válidas (API_URL, CLIENT_ID, CLIENT_SECRET).'
      );
    }
  }

  /**
   * Inicia um pedido de débito na carteira Unitel Money do utilizador.
   *
   * @param {import('../contracts/payment-request.contract').PaymentRequestDTO} paymentRequest
   */
  async initiatePayment(paymentRequest) {
    this.ensureConfigured();

    // Normaliza o número móvel para formato nacional sem prefixo ou com 9 dígitos
    let msisdn = paymentRequest.phoneNumber ? paymentRequest.phoneNumber.replace(/\D/g, '') : '';
    if (msisdn.startsWith('244')) {
      msisdn = msisdn.substring(3);
    }

    const requestPayload = {
      external_reference: paymentRequest.merchantReference,
      msisdn,
      amount: paymentRequest.amount,
      currency: paymentRequest.currency,
      narrative: paymentRequest.description,
      validity_minutes: 15
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.httpTimeoutMs || 15000);

    try {
      const response = await fetch(`${this.config.apiUrl}/merchant/debit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-ID': this.config.clientId,
          'Authorization': `Bearer ${this.config.clientSecret}`,
          'X-Correlation-ID': paymentRequest.merchantReference
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal
      });

      const responseData = await response.json();

      if (!response.ok) {
        return {
          providerTransactionId: responseData.transaction_reference || `ERR-UM-${Date.now()}`,
          status: 'FAILED',
          qrPayload: null,
          rawResponse: responseData
        };
      }

      return {
        providerTransactionId: responseData.transaction_reference,
        status: responseData.transaction_status === 'SUCCESSFUL' ? 'SUCCEEDED' : 'PENDING',
        qrPayload: responseData.qr_token || null,
        rawResponse: responseData
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('[UNITEL_MONEY_PROVIDER] Tempo limite esgotado na comunicação com a API da Unitel Money.');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Consulta o estado de um pagamento na infraestrutura da Unitel Money.
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
        `${this.config.apiUrl}/merchant/transactions/${encodeURIComponent(providerTransactionId)}?reference=${encodeURIComponent(merchantReference)}`,
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
      if (responseData.status === 'SUCCESS' || responseData.status === 'COMPLETED') {
        mappedStatus = 'SUCCEEDED';
      } else if (responseData.status === 'FAILED' || responseData.status === 'EXPIRED') {
        mappedStatus = responseData.status === 'EXPIRED' ? 'EXPIRED' : 'FAILED';
      }

      return {
        providerTransactionId,
        merchantReference,
        status: mappedStatus,
        amount: responseData.amount || 0,
        currency: responseData.currency || 'AOA',
        paidAt: responseData.timestamp ? new Date(responseData.timestamp) : undefined,
        rawResponse: responseData
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Valida a assinatura HMAC da Unitel Money no cabeçalho x-unitel-signature.
   *
   * @param {object} headers
   * @param {string|Buffer} rawBody
   * @param {string} webhookSecret
   */
  verifyWebhookSignature(headers, rawBody, webhookSecret) {
    if (!webhookSecret) {
      return false;
    }

    const signature = headers['x-unitel-signature'] || headers['x-signature'];
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
   * Converte o payload de notificação da Unitel Money para o WebhookEventDTO padronizado.
   *
   * @param {object} headers
   * @param {object} payload
   */
  parseWebhookEvent(headers, payload) {
    const isSuccess = payload.status === 'SUCCESS' || payload.status === 'COMPLETED';

    return WebhookEventDTO.from({
      provider: 'UNITEL_MONEY',
      eventId: payload.event_id || payload.callback_id || `UM-${payload.transaction_id}`,
      eventType: payload.type || 'PAYMENT_NOTIFICATION',
      merchantReference: payload.external_reference || payload.reference,
      providerTransactionId: String(payload.transaction_id || payload.transaction_reference),
      amount: Number(payload.amount),
      currency: payload.currency || 'AOA',
      status: isSuccess ? 'SUCCEEDED' : 'FAILED',
      occurredAt: payload.created_at ? new Date(payload.created_at) : new Date(),
      rawPayload: payload
    });
  }

  /**
   * Solicita estorno ou reversão de fundos junto à Unitel Money.
   *
   * @param {object} refundRequest
   */
  async requestRefund(refundRequest) {
    this.ensureConfigured();

    const response = await fetch(`${this.config.apiUrl}/merchant/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-ID': this.config.clientId,
        'Authorization': `Bearer ${this.config.clientSecret}`
      },
      body: JSON.stringify({
        original_reference: refundRequest.merchantReference,
        transaction_reference: refundRequest.providerTransactionId,
        amount: refundRequest.amount,
        reason: refundRequest.reason
      })
    });

    const data = await response.json();

    return {
      refundTransactionId: data.refund_reference || `REF-${Date.now()}`,
      status: data.status === 'APPROVED' ? 'SUCCEEDED' : 'PROCESSING',
      rawResponse: data
    };
  }

  /**
   * Obtém o lote de extrato da Unitel Money para auditoria e conciliação financeira.
   *
   * @param {Date} periodStart
   * @param {Date} periodEnd
   */
  async fetchReconciliationBatch(periodStart, periodEnd) {
    this.ensureConfigured();

    const queryParams = new URLSearchParams({
      from: periodStart.toISOString(),
      to: periodEnd.toISOString()
    });

    const response = await fetch(`${this.config.apiUrl}/merchant/reconciliation/export?${queryParams.toString()}`, {
      method: 'GET',
      headers: {
        'X-Client-ID': this.config.clientId,
        'Authorization': `Bearer ${this.config.clientSecret}`
      }
    });

    if (!response.ok) {
      throw new Error(`[UNITEL_MONEY_PROVIDER] Falha ao descarregar lote de conciliação: HTTP ${response.status}`);
    }

    const data = await response.json();
    const records = Array.isArray(data.items) ? data.items : [];

    return records.map((r) => ({
      providerTransactionId: String(r.transaction_reference),
      merchantReference: String(r.external_reference),
      amount: Number(r.amount),
      currency: r.currency || 'AOA',
      status: r.status === 'SUCCESS' ? 'SETTLED' : 'FAILED',
      settledAt: new Date(r.timestamp)
    }));
  }
}

module.exports = UnitelMoneyProvider;