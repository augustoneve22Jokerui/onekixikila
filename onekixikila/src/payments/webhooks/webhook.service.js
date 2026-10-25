const providerFactory = require('../providers/provider-factory');
const webhookVerifier = require('./webhook-verifier');
const webhookRepository = require('./webhook.repository');
const { withTransaction } = require('../../database/transaction');

/**
 * Serviço orquestrador de eventos e notificações assíncronas de pagamento.
 * Garante verificação de assinaturas, deduplicação idempotente e liquidação contábil atómica.
 */
class WebhookService {
  /**
   * Processa uma notificação de webhook de ponta a ponta.
   *
   * @param {object} params
   * @param {string} params.provider - Identificador do prestador (ex: 'multicaixa_express', 'unitel_money')
   * @param {object} params.headers - Cabeçalhos HTTP recebidos
   * @param {object} params.payload - Carga JSON parseada
   * @param {string|Buffer} params.rawBody - Corpo bruto da requisição para validação de assinatura
   * @returns {Promise<{ status: string, message: string, eventId: string }>}
   */
  async processIncomingWebhook({ provider, headers, payload, rawBody }) {
    // 1. Resolve o adaptador do prestador
    const adapter = providerFactory.getProvider(provider);

    // 2. Validação da assinatura criptográfica do webhook
    const isSignatureValid = webhookVerifier.verifySignature({
      adapter,
      headers,
      rawBody
    });

    if (!isSignatureValid) {
      const error = new Error(`Assinatura de webhook inválida para o prestador [${provider}].`);
      error.code = 'INVALID_WEBHOOK_SIGNATURE';
      throw error;
    }

    // 3. Tradução para o DTO canónico padronizado
    const canonicalEvent = adapter.parseWebhookEvent(headers, payload);

    // 4. Verificação de idempotência: evento já registado ou processado anteriormente
    const existingEvent = await webhookRepository.findEventByProviderAndId(
      canonicalEvent.provider,
      canonicalEvent.eventId
    );

    if (existingEvent) {
      if (existingEvent.status === 'PROCESSED' || existingEvent.status === 'DUPLICATE') {
        return {
          status: 'DUPLICATE',
          message: 'Evento já recebido e liquidado anteriormente. Descarte seguro.',
          eventId: canonicalEvent.eventId
        };
      }
    }

    // 5. Registo do evento no histórico bruto imutável
    const savedEvent = await webhookRepository.recordIncomingEvent({
      provider: canonicalEvent.provider,
      eventId: canonicalEvent.eventId,
      eventType: canonicalEvent.eventType,
      signatureHeader: JSON.stringify(headers['x-emis-signature'] || headers['x-unitel-signature'] || headers['x-ekwanza-signature'] || headers['x-signature'] || null),
      isSignatureValid: true,
      payload: canonicalEvent.rawPayload
    });

    // 6. Execução atómica da liquidação financeira correspondente
    await withTransaction(async (client) => {
      // Localiza o pedido de pagamento associado pela referência única da OneKixikila
      const paymentRequest = await webhookRepository.findPaymentRequestByReference(
        canonicalEvent.merchantReference,
        client
      );

      if (!paymentRequest) {
        await webhookRepository.markEventStatus(
          savedEvent.id,
          'IGNORED',
          'Pedido de pagamento não localizado pela merchantReference informada.',
          client
        );
        return;
      }

      // Vincula o ID do pedido ao evento do prestador
      await webhookRepository.linkEventToPaymentRequest(savedEvent.id, paymentRequest.id, client);

      // Tratamento para pagamentos concluídos com sucesso
      if (canonicalEvent.status === 'SUCCEEDED') {
        await webhookRepository.updatePaymentRequestSuccess({
          paymentRequestId: paymentRequest.id,
          providerTransactionId: canonicalEvent.providerTransactionId,
          paidAt: canonicalEvent.occurredAt,
          client
        });

        // Caso 1: Liquidação de Depósito em Carteira
        if (paymentRequest.deposit_id) {
          await webhookRepository.settleDepositTransaction({
            depositId: paymentRequest.deposit_id,
            walletId: paymentRequest.wallet_id,
            userId: paymentRequest.user_id,
            amount: canonicalEvent.amount,
            merchantReference: canonicalEvent.merchantReference,
            client
          });
        }

        // Caso 2: Liquidação Direta de Quota de Kixikila
        if (paymentRequest.contribution_id) {
          await webhookRepository.settleContributionTransaction({
            contributionId: paymentRequest.contribution_id,
            merchantReference: canonicalEvent.merchantReference,
            client
          });
        }
      } else {
        // Tratamento para pagamentos recusados ou falhados
        await webhookRepository.updatePaymentRequestFailure({
          paymentRequestId: paymentRequest.id,
          providerTransactionId: canonicalEvent.providerTransactionId,
          client
        });

        if (paymentRequest.deposit_id) {
          await webhookRepository.markDepositFailed(paymentRequest.deposit_id, client);
        }

        if (paymentRequest.contribution_id) {
          await webhookRepository.markContributionFailed(paymentRequest.contribution_id, client);
        }
      }

      // 7. Marca o evento como totalmente processado
      await webhookRepository.markEventStatus(savedEvent.id, 'PROCESSED', null, client);
    });

    return {
      status: 'PROCESSED',
      message: 'Notificação de webhook liquidada e contabilizada com sucesso.',
      eventId: canonicalEvent.eventId
    };
  }
}

// Instância singleton do serviço
const webhookService = new WebhookService();

module.exports = webhookService;