const depositsRepository = require('./deposits.repository');
const depositsPolicy = require('./deposits.policy');
const providerFactory = require('../../payments/providers/provider-factory');
const balanceManager = require('../../shared/finance/balance');
const financialIdempotency = require('../../shared/finance/idempotency');
const { withTransaction } = require('../../database/transaction');
const { queryOneClient, queryClient } = require('../../database/query');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço orquestrador de regras de negócio para Depósitos na Carteira Digital
 * da plataforma OneKixikila.
 */
class DepositsService {
  /**
   * Inicia um fluxo de depósito na carteira interna.
   * Valida conformidade KYC, limites cumulativos diários/mensais em Kwanzas (AOA),
   * gera a referência comercial única e despacha a requisição para o prestador angolano
   * (Multicaixa Express, Unitel Money ou e-Kwanza).
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} depositData - Parâmetros { amount, provider, phoneNumber, idempotencyKey }
   * @param {object} [context={}]
   * @returns {Promise<object>} Ficha do depósito e instruções de pagamento
   */
  async createDeposit(actingUser, depositData, context = {}) {
    const {
      amount,
      provider,
      phoneNumber = null,
      idempotencyKey: providedKey
    } = depositData;

    // 1. Obtém a carteira do utilizador
    const walletSql = `SELECT id, user_id, status, available_balance, ledger_balance, locked_balance FROM wallets WHERE user_id = $1;`;
    const wallet = await withTransaction((client) => queryOneClient(client, walletSql, [actingUser.id]));
    if (!wallet) {
      throw NotFoundError.wallet(actingUser.id);
    }

    // 2. Apura volumes cumulativos transacionados no dia e no mês para conformidade de limites
    const volumes = await depositsRepository.getUserDepositedVolumes(actingUser.id);

    // 3. Validação das políticas de limites KYC e integridade
    const policyCheck = depositsPolicy.canCreateDeposit(actingUser, wallet, amount, volumes);
    if (!policyCheck.allowed) {
      const err = new ConflictError(policyCheck.reason, 'DEPOSIT_LIMIT_EXCEEDED');
      err.statusCode = policyCheck.statusCode || 422;
      err.status = err.statusCode;
      throw err;
    }

    // 4. Validação da chave de idempotência
    const idempotencyKey = providedKey
      ? financialIdempotency.validateKey(providedKey)
      : financialIdempotency.generateKey('DEP', actingUser.id, Date.now());

    // 5. Verificação de repetição prévia
    const existing = await depositsRepository.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      return {
        id: existing.id,
        referenceNumber: existing.reference_number,
        amount: Number(existing.amount),
        status: existing.status,
        message: 'Depósito previamente registado retornado por idempotência.'
      };
    }

    // 6. Preparação dos montantes e referências (Taxa de depósito padrão = 0 Kz)
    const grossAmount = BigInt(amount);
    const feeAmount = 0n; // Depósitos isentos de comissão na plataforma
    const netAmount = grossAmount - feeAmount;

    const referenceNumber = `DEP-${actingUser.id.slice(0, 4).toUpperCase()}-${Date.now()}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos de validade

    const targetPhone = phoneNumber || actingUser.phoneNumber;
    if (!targetPhone) {
      throw ValidationError.fieldRequired('phoneNumber');
    }

    // 7. Persistência atómica da intenção de depósito no estado CREATED
    const createdDeposit = await withTransaction(async (client) => {
      const deposit = await depositsRepository.createDeposit(
        {
          walletId: wallet.id,
          userId: actingUser.id,
          referenceNumber,
          idempotencyKey,
          amount: Number(grossAmount),
          feeAmount: Number(feeAmount),
          netAmount: Number(netAmount),
          currency: 'AOA',
          provider,
          status: 'CREATED',
          expiresAt,
          metadata: {
            phoneNumber: targetPhone,
            initiatorIp: context.ipAddress || null
          }
        },
        client
      );

      // Regista o pedido na tabela de payment_requests para correlação de webhooks
      const paymentReqSql = `
        INSERT INTO payment_requests (
          user_id,
          wallet_id,
          deposit_id,
          merchant_reference,
          provider,
          channel,
          amount,
          currency,
          phone_number,
          status,
          expires_at
        )
        VALUES ($1, $2, $3, $4, $5, 'MOBILE', $6, 'AOA', $7, 'PENDING', $8)
        RETURNING id;
      `;
      await queryOneClient(client, paymentReqSql, [
        actingUser.id,
        wallet.id,
        deposit.id,
        referenceNumber,
        provider.toUpperCase(),
        Number(grossAmount),
        targetPhone,
        expiresAt
      ]);

      return deposit;
    });

    // 8. Despacho da cobrança móvel ou QR Code ao prestador
    const adapter = providerFactory.getProvider(provider.toLowerCase());
    let gatewayResult;

    try {
      gatewayResult = await adapter.initiatePayment({
        merchantReference: referenceNumber,
        amount: Number(grossAmount),
        currency: 'AOA',
        phoneNumber: targetPhone,
        description: `Depósito Carteira OneKixikila - ${referenceNumber}`,
        expiresAt
      });
    } catch (gatewayError) {
      await depositsRepository.updateStatus(createdDeposit.id, 'FAILED');
      throw gatewayError;
    }

    // Atualiza com a referência do prestador e muda status para PENDING_PAYMENT
    const updated = await depositsRepository.updateStatus(createdDeposit.id, 'PENDING_PAYMENT', {
      providerReference: gatewayResult.providerTransactionId
    });

    eventBus.publish(
      EVENT_TYPES.DEPOSIT_INITIATED,
      {
        depositId: updated.id,
        userId: actingUser.id,
        amount: Number(grossAmount),
        provider,
        referenceNumber
      },
      { requestId: context.requestId }
    );

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'FINANCIAL_TRANSACTION',
        resourceType: 'DEPOSIT',
        resourceId: updated.id,
        metadata: {
          amount: Number(grossAmount),
          provider,
          referenceNumber
        }
      });
    }

    return {
      success: true,
      status: 'PENDING_PAYMENT',
      depositId: updated.id,
      referenceNumber,
      providerTransactionId: gatewayResult.providerTransactionId,
      amount: Number(grossAmount),
      currency: 'AOA',
      qrPayload: gatewayResult.qrPayload || null,
      expiresAt: expiresAt.toISOString(),
      message: 'Intenção de depósito registada. Conclua a autorização de pagamento no seu telemóvel.'
    };
  }

  /**
   * Consulta os dados detalhados de um depósito específico com validação de titularidade Anti-IDOR.
   *
   * @param {object} actingUser
   * @param {string} depositId
   * @returns {Promise<object>}
   */
  async getDepositById(actingUser, depositId) {
    const deposit = await depositsRepository.findById(depositId);
    if (!deposit) {
      throw NotFoundError.resource('Depósito', depositId);
    }

    if (!depositsPolicy.canViewDeposit(actingUser, deposit)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado aos dados deste depósito.');
    }

    return deposit;
  }

  /**
   * Cancela uma intenção de depósito pendente antes da liquidação bancária.
   *
   * @param {object} actingUser
   * @param {string} depositId
   * @param {object} [context={}]
   * @returns {Promise<{ message: string }>}
   */
  async cancelDeposit(actingUser, depositId, context = {}) {
    const deposit = await depositsRepository.findById(depositId);
    if (!deposit) {
      throw NotFoundError.resource('Depósito', depositId);
    }

    const cancelCheck = depositsPolicy.canCancelDeposit(actingUser, deposit);
    if (!cancelCheck.allowed) {
      throw new ConflictError(cancelCheck.reason, 'DEPOSIT_CANCEL_BLOCKED');
    }

    await depositsRepository.updateStatus(depositId, 'CANCELLED');

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'STATUS_CHANGE',
        resourceType: 'DEPOSIT',
        resourceId: depositId,
        oldValues: { status: deposit.status },
        newValues: { status: 'CANCELLED' }
      });
    }

    return {
      message: 'Intenção de depósito cancelada com sucesso.'
    };
  }

  /**
   * Lista o histórico pessoal de depósitos do utilizador com filtros e paginação.
   *
   * @param {object} user - Utilizador autenticado (req.user)
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listUserDeposits(user, filters, paginationParams) {
    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await depositsRepository.listUserDeposits(user.id, filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }
}

// Instância singleton do serviço de depósitos
const depositsService = new DepositsService();

module.exports = depositsService;