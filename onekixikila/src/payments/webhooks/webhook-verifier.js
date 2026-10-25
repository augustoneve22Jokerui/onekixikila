const paymentsConfig = require('../../config/payments');
const appConfig = require('../../config/app');

/**
 * Utilitário especializado em validação de segurança e integridade criptográfica de webhooks.
 * Verifica assinaturas HMAC e janelas de tolerância de timestamps para prevenir ataques de repetição (replay attacks).
 */
class WebhookVerifier {
  /**
   * Valida a assinatura de uma notificação recebida de um prestador de pagamento.
   *
   * @param {object} params
   * @param {import('../contracts/payment-provider.contract')} params.adapter - Instância do adaptador do prestador
   * @param {object} params.headers - Cabeçalhos HTTP do pedido recebido
   * @param {string|Buffer} params.rawBody - Corpo bruto da requisição
   * @returns {boolean}
   */
  verifySignature({ adapter, headers, rawBody }) {
    if (!adapter) {
      return false;
    }

    const providerConfig = adapter.config || {};
    const webhookSecret = providerConfig.webhookSecret;

    // Se em ambiente de desenvolvimento sem credenciais configuradas, registra alerta controlado
    if (!webhookSecret) {
      if (appConfig.isDevelopment) {
        console.warn(
          `[WEBHOOK_VERIFIER:WARN] Webhook secret não configurado para [${adapter.providerId}]. Autorizado apenas em desenvolvimento.`
        );
        return true;
      }
      console.error(
        `[WEBHOOK_VERIFIER:FATAL] Webhook secret ausente para [${adapter.providerId}] em ambiente de produção.`
      );
      return false;
    }

    // 1. Validação de Janela Temporal de Timestamp (se fornecido no cabeçalho do gateway)
    const timestampHeader =
      headers['x-timestamp'] ||
      headers['x-signature-timestamp'] ||
      headers['x-emis-timestamp'] ||
      headers['x-unitel-timestamp'];

    if (timestampHeader) {
      const eventTimestamp = new Date(Number(timestampHeader) || timestampHeader).getTime();
      const currentTimestamp = Date.now();
      const differenceMs = Math.abs(currentTimestamp - eventTimestamp);

      if (differenceMs > paymentsConfig.webhookTimestampToleranceMs) {
        console.warn(
          `[WEBHOOK_VERIFIER:REPLAY_ATTACK] Timestamp fora da tolerância: ${differenceMs}ms decorridos.`
        );
        return false;
      }
    }

    // 2. Delegação da verificação criptográfica ao método especializado do adaptador
    try {
      return adapter.verifyWebhookSignature(headers, rawBody, webhookSecret);
    } catch (error) {
      console.error(
        `[WEBHOOK_VERIFIER:ERROR] Erro ao validar assinatura de [${adapter.providerId}]:`,
        error.message
      );
      return false;
    }
  }
}

// Instância singleton do verificador
const webhookVerifier = new WebhookVerifier();

module.exports = webhookVerifier;