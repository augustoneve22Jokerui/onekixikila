const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência para eventos de webhook, liquidações contábeis e pedidos de pagamento.
 */
class WebhookRepository {
  /**
   * Consulta um evento pelo prestador e identificador único de evento para prevenir duplicidade.
   *
   * @param {string} provider
   * @param {string} eventId
   * @returns {Promise<any|null>}
   */
  async findEventByProviderAndId(provider, eventId) {
    const text = `
      SELECT id, provider, event_id, event_type, status, received_at, processed_at
      FROM payment_provider_events
      WHERE provider = $1 AND event_id = $2;
    `;
    return queryOne(text, [provider, eventId]);
  }

  /**
   * Grava o evento de webhook bruto recebido na tabela payment_provider_events.
   *
   * @param {object} params
   * @returns {Promise<{ id: string }>}
   */
  async recordIncomingEvent({ provider, eventId, eventType, signatureHeader, isSignatureValid, payload }) {
    const text = `
      INSERT INTO payment_provider_events (
        provider, event_id, event_type, signature_header, is_signature_valid, status, payload
      )
      VALUES ($1, $2, $3, $4, $5, 'RECEIVED', $6)
      RETURNING id;
    `;
    return queryOne(text, [
      provider,
      eventId,
      eventType,
      signatureHeader,
      isSignatureValid,
      JSON.stringify(payload)
    ]);
  }

  /**
   * Localiza um pedido de pagamento pela referência comercial única.
   *
   * @param {string} merchantReference
   * @param {import('pg').PoolClient} [client]
   */
  async findPaymentRequestByReference(merchantReference, client = null) {
    const text = `
      SELECT 
        id, user_id, wallet_id, group_id, deposit_id, contribution_id,
        merchant_reference, provider, amount, currency, status
      FROM payment_requests
      WHERE merchant_reference = $1;
    `;
    const executor = client ? queryOneClient(client, text, [merchantReference]) : queryOne(text, [merchantReference]);
    return executor;
  }

  /**
   * Associa o identificador do pedido de pagamento ao registo do evento de webhook.
   */
  async linkEventToPaymentRequest(eventId, paymentRequestId, client) {
    const text = `
      UPDATE payment_provider_events
      SET payment_request_id = $1
      WHERE id = $2;
    `;
    return queryClient(client, text, [paymentRequestId, eventId]);
  }

  /**
   * Atualiza o pedido de pagamento para o estado SUCCEEDED.
   */
  async updatePaymentRequestSuccess({ paymentRequestId, providerTransactionId, paidAt, client }) {
    const text = `
      UPDATE payment_requests
      SET status = 'SUCCEEDED',
          provider_transaction_id = $1,
          paid_at = $2,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $3;
    `;
    return queryClient(client, text, [providerTransactionId, paidAt, paymentRequestId]);
  }

  /**
   * Atualiza o pedido de pagamento para o estado FAILED.
   */
  async updatePaymentRequestFailure({ paymentRequestId, providerTransactionId, client }) {
    const text = `
      UPDATE payment_requests
      SET status = 'FAILED',
          provider_transaction_id = COALESCE($1, provider_transaction_id),
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2;
    `;
    return queryClient(client, text, [providerTransactionId, paymentRequestId]);
  }

  /**
   * Executa a liquidação contábil completa de um depósito em carteira (Partidas Dobradas e Saldo).
   */
  async settleDepositTransaction({ depositId, walletId, userId, amount, merchantReference, client }) {
    // 1. Localiza a conta de compensação do sistema (Ativo) e a conta do utilizador (Passivo)
    const sysAccountQuery = `SELECT id FROM ledger_accounts WHERE account_code = '1001-SETTLEMENT-POOL';`;
    const sysAccount = await queryOneClient(client, sysAccountQuery);

    const userAccountQuery = `SELECT id FROM ledger_accounts WHERE user_id = $1 AND wallet_id = $2;`;
    const userAccount = await queryOneClient(client, userAccountQuery, [userId, walletId]);

    // 2. Criação do cabeçalho da transação no Livro-Razão
    const txQuery = `
      INSERT INTO ledger_transactions (
        reference_code, idempotency_key, operation_type, status, amount, currency, description, metadata
      )
      VALUES ($1, $2, 'DEPOSIT', 'POSTED', $3, 'AOA', 'Depósito confirmado via Webhook Gateway', $4)
      RETURNING id;
    `;
    const ledgerTx = await queryOneClient(client, txQuery, [
      `LTX-DEP-${merchantReference}`,
      `IDEMP-WH-${merchantReference}`,
      amount,
      JSON.stringify({ depositId, merchantReference })
    ]);

    // 3. Lançamento em Partidas Dobradas: Débito no Ativo de Compensação e Crédito no Passivo do Utilizador
    if (sysAccount && userAccount) {
      await queryClient(
        client,
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount, currency, sequence)
         VALUES ($1, $2, 'DEBIT', $3, 'AOA', 1);`,
        [ledgerTx.id, sysAccount.id, amount]
      );

      await queryClient(
        client,
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount, currency, sequence)
         VALUES ($1, $2, 'CREDIT', $3, 'AOA', 2);`,
        [ledgerTx.id, userAccount.id, amount]
      );
    }

    // 4. Incremento do saldo contabilístico e disponível da carteira
    await queryClient(
      client,
      `UPDATE wallets
       SET ledger_balance = ledger_balance + $1,
           available_balance = available_balance + $1,
           updated_at = NOW() AT TIME ZONE 'UTC'
       WHERE id = $2;`,
      [amount, walletId]
    );

    // 5. Atualização do registo de depósito
    await queryClient(
      client,
      `UPDATE deposits
       SET status = 'SETTLED',
           confirmed_at = NOW() AT TIME ZONE 'UTC',
           settled_at = NOW() AT TIME ZONE 'UTC',
           ledger_transaction_id = $1,
           updated_at = NOW() AT TIME ZONE 'UTC'
       WHERE id = $2;`,
      [ledgerTx.id, depositId]
    );
  }

  /**
   * Executa a confirmação e liquidação direta de uma quota de Kixikila.
   */
  async settleContributionTransaction({ contributionId, merchantReference, client }) {
    // 1. Atualiza a contribuição para CONFIRMED
    const contrib = await queryOneClient(
      client,
      `UPDATE contributions
       SET status = 'CONFIRMED',
           confirmed_at = NOW() AT TIME ZONE 'UTC',
           updated_at = NOW() AT TIME ZONE 'UTC'
       WHERE id = $1
       RETURNING obligation_id, schedule_id, amount;`,
      [contributionId]
    );

    if (contrib) {
      // 2. Quita a obrigação financeira correspondente
      await queryClient(
        client,
        `UPDATE contribution_obligations
         SET status = 'PAID',
             paid_amount = $1,
             paid_at = NOW() AT TIME ZONE 'UTC',
             updated_at = NOW() AT TIME ZONE 'UTC'
         WHERE id = $2;`,
        [contrib.amount, contrib.obligation_id]
      );
    }
  }

  /**
   * Marca o depósito como falhado em caso de rejeição no webhook.
   */
  async markDepositFailed(depositId, client) {
    const text = `
      UPDATE deposits
      SET status = 'FAILED',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $1;
    `;
    return queryClient(client, text, [depositId]);
  }

  /**
   * Marca a contribuição como falhada em caso de rejeição no webhook.
   */
  async markContributionFailed(contributionId, client) {
    const text = `
      UPDATE contributions
      SET status = 'FAILED',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $1;
    `;
    return queryClient(client, text, [contributionId]);
  }

  /**
   * Atualiza o estado de processamento do evento de webhook na tabela payment_provider_events.
   */
  async markEventStatus(eventId, status, processingError, client) {
    const text = `
      UPDATE payment_provider_events
      SET status = $1,
          processing_error = $2,
          processed_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $3;
    `;
    return queryClient(client, text, [status, processingError, eventId]);
  }
}

// Instância singleton do repositório
const webhookRepository = new WebhookRepository();

module.exports = webhookRepository;