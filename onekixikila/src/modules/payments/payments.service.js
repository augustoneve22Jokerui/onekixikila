const paymentsRepository = require('./payments.repository');
const paymentsPolicy = require('./payments.policy');
const providerFactory = require('../../payments/providers/provider-factory');
const financialIdempotency = require('../../shared/finance/idempotency');
const { withTransaction } = require('../../database/transaction');
const { queryOneClient } = require('../../database/query');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço de regras de negócio para Orquestração, Consulta e Cancelamento
 * de Pedidos de Pagamento Externos na plataforma OneKixikila.
 */
class PaymentsService {
  /**
   * Inicia formalmente um pedido de pagamento junto a um prestador externo angolano
   * (Multicaixa Express, Unitel Money ou e-Kwanza).
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} paymentData - Dados validados por initiatePaymentSchema
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async initiatePayment(actingUser, paymentData, context = {}) {
    // 1. Validação de elegibilidade da conta
    const userCheck = paymentsPolicy.canInitiatePayment(actingUser);
    if (!userCheck.allowed) {
      throw new ConflictError(userCheck.reason, 'PAYMENT_INITIATION_BLOCKED');
    }

    // 2. Validação da estrutura do pedido e suporte do prestador
    const structureCheck = paymentsPolicy.validatePaymentRequestData(paymentData);
    if (!structureCheck.valid) {
      throw new ValidationError(structureCheck.reason);
    }

    const {
      provider,
      channel = 'MOBILE',
      amount,
      phoneNumber = null,
      description = 'Pagamento OneKixikila',
      groupId = null,
      contributionId = null,
      depositId = null,
      idempotencyKey: providedKey
    } = paymentData;

    // 3. Localiza a carteira digital do utilizador
    const walletSql = `SELECT id FROM wallets WHERE user_id = $1;`;
    const wallet = await withTransaction((client) => queryOneClient(client, walletSql, [actingUser.id]));
    if (!wallet) {
      throw NotFoundError.wallet(actingUser.id);
    }

    // 4. Gestão da chave de idempotência
    const idempotencyKey = providedKey
      ? financialIdempotency.validateKey(providedKey)
      : financialIdempotency.generateKey('PAY', actingUser.id, Date.now());

    const targetPhone = phoneNumber || actingUser.phoneNumber;
    if (channel === 'MOBILE' && !targetPhone) {
      throw ValidationError.fieldRequired('phoneNumber');
    }

    const grossAmount = BigInt(amount);
    const merchantReference = `PAY-${actingUser.id.slice(0, 4).toUpperCase()}-${Date.now()}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

    // 5. Persistência atómica da intenção de pagamento no PostgreSQL
    const createdRequest = await withTransaction(async (client) => {
      return paymentsRepository.createPaymentRequest(
        {
          userId: actingUser.id,
          walletId: wallet.id,
          groupId,
          depositId,
          contributionId,
          merchantReference,
          provider,
          channel,
          amount: Number(grossAmount),
          currency: 'AOA',
          phoneNumber: targetPhone,
          status: 'PENDING',
          expiresAt,
          metadata: {
            idempotencyKey,
            initiatorIp: context.ipAddress || null
          }
        },
        client
      );
    });

    // 6. Despacho da cobrança ao adaptador do gateway selecionado
    const adapter = providerFactory.getProvider(provider.toLowerCase());
    let gatewayResult;

    try {
      gatewayResult = await adapter.initiatePayment({
        merchantReference,
        amount: Number(grossAmount),
        currency: 'AOA',
        phoneNumber: targetPhone,
        description,
        expiresAt
      });
    } catch (gatewayError) {
      await paymentsRepository.updateStatus(createdRequest.id, 'FAILED');
      throw gatewayError;
    }

    // 7. Atualiza o registo com o ID retornado pelo prestador
    const updated = await paymentsRepository.updateStatus(createdRequest.id, 'PENDING', {
      providerTransactionId: gatewayResult.providerTransactionId
    });

    eventBus.publish(
      EVENT_TYPES.PAYMENT_REQUEST_CREATED,
      {
        paymentRequestId: updated.id,
        merchantReference,
        provider,
        amount: Number(grossAmount),
        userId: actingUser.id
      },
      { requestId: context.requestId }
    );

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'CREATE',
        resourceType: 'PAYMENT_REQUEST',
        resourceId: updated.id,
        metadata: {
          merchantReference,
          provider,
          amount: Number(grossAmount)
        }
      });
    }

    return {
      success: true,
      status: 'PENDING',
      paymentRequestId: updated.id,
      merchantReference,
      providerTransactionId: gatewayResult.providerTransactionId,
      amount: Number(grossAmount),
      currency: 'AOA',
      qrPayload: gatewayResult.qrPayload || null,
      expiresAt: expiresAt.toISOString(),
      message: 'Pedido de pagamento iniciado. Conclua a autorização no seu aplicativo bancário ou carteira móvel.'
    };
  }

  /**
   * Consulta os dados detalhados e o estado de uma ordem de pagamento (Anti-IDOR).
   *
   * @param {object} actingUser
   * @param {string} paymentId
   * @returns {Promise<object>}
   */
  async getPaymentRequestById(actingUser, paymentId) {
    const paymentRequest = await paymentsRepository.findById(paymentId);
    if (!paymentRequest) {
      throw NotFoundError.resource('Pedido de Pagamento', paymentId);
    }

    if (!paymentsPolicy.canViewPaymentRequest(actingUser, paymentRequest)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado a este pedido de pagamento.');
    }

    return paymentRequest;
  }

  /**
   * Consulta ativa do estado de uma ordem no gateway caso a notificação de webhook tenha atrasado.
   *
   * @param {object} actingUser
   * @param {string} paymentId
   * @returns {Promise<object>}
   */
  async checkPaymentStatus(actingUser, paymentId) {
    const paymentRequest = await paymentsRepository.findById(paymentId);
    if (!paymentRequest) {
      throw NotFoundError.resource('Pedido de Pagamento', paymentId);
    }

    if (!paymentsPolicy.canViewPaymentRequest(actingUser, paymentRequest)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado a este pedido de pagamento.');
    }

    // Se já estiver em estado terminal, retorna os dados cacheados
    if (paymentRequest.status !== 'PENDING' && paymentRequest.status !== 'PROCESSING') {
      return paymentRequest;
    }

    const adapter = providerFactory.getProvider(paymentRequest.provider.toLowerCase());
    const statusResult = await adapter.checkPaymentStatus(
      paymentRequest.provider_transaction_id || paymentRequest.merchant_reference,
      paymentRequest.merchant_reference
    );

    if (statusResult.status !== paymentRequest.status && statusResult.status !== 'PENDING') {
      await paymentsRepository.updateStatus(paymentRequest.id, statusResult.status, {
        paidAt: statusResult.paidAt
      });
      paymentRequest.status = statusResult.status;
      paymentRequest.paid_at = statusResult.paidAt || null;
    }

    return paymentRequest;
  }

  /**
   * Cancela uma ordem de pagamento pendente.
   *
   * @param {object} actingUser
   * @param {string} paymentId
   * @param {object} [context={}]
   * @returns {Promise<{ message: string }>}
   */
  async cancelPaymentRequest(actingUser, paymentId, context = {}) {
    const paymentRequest = await paymentsRepository.findById(paymentId);
    if (!paymentRequest) {
      throw NotFoundError.resource('Pedido de Pagamento', paymentId);
    }

    const cancelCheck = paymentsPolicy.canCancelPaymentRequest(actingUser, paymentRequest);
    if (!cancelCheck.allowed) {
      throw new ConflictError(cancelCheck.reason, 'PAYMENT_CANCEL_BLOCKED');
    }

    await paymentsRepository.updateStatus(paymentId, 'CANCELLED');

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'STATUS_CHANGE',
        resourceType: 'PAYMENT_REQUEST',
        resourceId: paymentId,
        oldValues: { status: paymentRequest.status },
        newValues: { status: 'CANCELLED' }
      });
    }

    return {
      message: 'Pedido de pagamento cancelado com sucesso.'
    };
  }

  /**
   * Lista as ordens de pagamento de um utilizador com filtros e paginação.
   *
   * @param {object} user - Utilizador autenticado (req.user)
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listUserPaymentRequests(user, filters, paginationParams) {
    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await paymentsRepository.listUserPaymentRequests(user.id, filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }
}

// Instância singleton do serviço de pagamentos
const paymentsService = new PaymentsService();

module.exports = paymentsService;