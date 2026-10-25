const withdrawalsRepository = require('./withdrawals.repository');
const withdrawalsPolicy = require('./withdrawals.policy');
const feesService = require('../fees/fees.service');
const ledgerService = require('../ledger/ledger.service');
const ledgerCalculator = require('../ledger/ledger-calculator');
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
 * Serviço orquestrador de regras de negócio para Levantamentos de Fundos (Withdrawals)
 * na plataforma OneKixikila.
 * Gerencia a reserva cautelar de fundos na carteira (`locked_balance`), cálculo auditado
 * de tarifas de transferência, liquidação contábil em partidas dobradas no livro-razão
 * e saídas seguras para contas bancárias angolanas (IBAN) ou carteiras móveis.
 */
class WithdrawalsService {
  /**
   * Submete uma nova solicitação de levantamento de fundos da carteira digital.
   * Valida conformidade KYC (nível verificado obrigatório), limites diários/mensais,
   * calcula taxas e reserva os fundos correspondentes no saldo retido (locked_balance).
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} withdrawalData - Parâmetros { amount, destinationType, destinationAccount, destinationHolderName, provider, idempotencyKey }
   * @param {object} [context={}]
   * @returns {Promise<object>} Ficha do levantamento solicitado
   */
  async requestWithdrawal(actingUser, withdrawalData, context = {}) {
    const {
      amount,
      destinationType,
      destinationAccount,
      destinationHolderName,
      provider = 'MULTICAIXA_EXPRESS',
      idempotencyKey: providedKey
    } = withdrawalData;

    // 1. Obtém a carteira do utilizador
    const walletSql = `SELECT id, user_id, status, available_balance, ledger_balance, locked_balance FROM wallets WHERE user_id = $1;`;
    const wallet = await withTransaction((client) => queryOneClient(client, walletSql, [actingUser.id]));
    if (!wallet) {
      throw NotFoundError.wallet(actingUser.id);
    }

    // 2. Apura os volumes já levantados na data atual (UTC) e no mês para conformidade
    const volumes = await withdrawalsRepository.getUserWithdrawnVolumes(actingUser.id);

    // 3. Calcula a tarifa institucional de levantamento
    const feeCalculation = await feesService.calculateFee('WITHDRAWAL', amount);
    const requestedAmountBigInt = BigInt(amount);
    const feeAmountBigInt = BigInt(feeCalculation.feeAmount);
    const totalDebitedBigInt = requestedAmountBigInt + feeAmountBigInt;

    // 4. Validação de políticas de acesso, KYC e conformidade de limites
    const policyCheck = withdrawalsPolicy.canRequestWithdrawal(
      actingUser,
      wallet,
      requestedAmountBigInt,
      totalDebitedBigInt,
      volumes
    );
    if (!policyCheck.allowed) {
      const err = new ConflictError(policyCheck.reason, 'WITHDRAWAL_POLICY_VIOLATION');
      err.statusCode = policyCheck.statusCode || 403;
      err.status = err.statusCode;
      throw err;
    }

    // 5. Validação da chave de idempotência financeira
    const idempotencyKey = providedKey
      ? financialIdempotency.validateKey(providedKey)
      : financialIdempotency.generateKey('WITHDRAW', actingUser.id, Date.now());

    // 6. Verificação de reenvio prévio
    const existing = await withdrawalsRepository.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      return {
        id: existing.id,
        referenceNumber: existing.reference_number,
        amount: Number(existing.amount),
        status: existing.status,
        message: 'Pedido de levantamento previamente submetido retornado por idempotência.'
      };
    }

    const referenceNumber = `WTH-${actingUser.id.slice(0, 4).toUpperCase()}-${Date.now()}`;

    // 7. Execução transacional atômica da reserva de fundos e registro da ordem
    const createdWithdrawal = await withTransaction(async (client) => {
      // Bloqueio pessimista de concorrência na carteira
      const lockWalletSql = `
        SELECT id, user_id, ledger_balance, available_balance, locked_balance, status
        FROM wallets
        WHERE id = $1
        FOR UPDATE;
      `;
      const lockedWalletRow = await queryOneClient(client, lockWalletSql, [wallet.id]);

      // Reserva os fundos na carteira (move de available para locked)
      const updatedBalances = balanceManager.reserveFunds(lockedWalletRow, totalDebitedBigInt);

      await queryClient(
        client,
        `UPDATE wallets
         SET available_balance = $1,
             locked_balance = $2,
             updated_at = NOW() AT TIME ZONE 'UTC'
         WHERE id = $3;`,
        [updatedBalances.available_balance, updatedBalances.locked_balance, wallet.id]
      );

      // Cria a ordem de levantamento no estado REQUESTED
      const withdrawalRecord = await withdrawalsRepository.createWithdrawal(
        {
          walletId: wallet.id,
          userId: actingUser.id,
          referenceNumber,
          idempotencyKey,
          amount: Number(requestedAmountBigInt),
          feeAmount: Number(feeAmountBigInt),
          totalDebited: Number(totalDebitedBigInt),
          currency: 'AOA',
          destinationType,
          destinationAccount: destinationAccount.trim(),
          destinationHolderName: destinationHolderName.trim(),
          provider: provider.toUpperCase(),
          status: 'REQUESTED',
          metadata: {
            feeCode: feeCalculation.feeCode,
            breakdown: feeCalculation.breakdown,
            initiatorIp: context.ipAddress || null
          }
        },
        client
      );

      return {
        withdrawal: withdrawalRecord,
        newAvailableBalance: updatedBalances.available_balance,
        newLockedBalance: updatedBalances.locked_balance
      };
    });

    eventBus.publish(
      EVENT_TYPES.WITHDRAWAL_REQUESTED,
      {
        withdrawalId: createdWithdrawal.withdrawal.id,
        userId: actingUser.id,
        amount: Number(requestedAmountBigInt),
        feeAmount: Number(feeAmountBigInt),
        totalDebited: Number(totalDebitedBigInt),
        destinationType,
        destinationAccount
      },
      { requestId: context.requestId }
    );

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'FINANCIAL_TRANSACTION',
        resourceType: 'WITHDRAWAL',
        resourceId: createdWithdrawal.withdrawal.id,
        metadata: {
          referenceNumber,
          amount: Number(requestedAmountBigInt),
          feeAmount: Number(feeAmountBigInt),
          destinationType
        }
      });
    }

    return {
      success: true,
      status: 'REQUESTED',
      withdrawalId: createdWithdrawal.withdrawal.id,
      referenceNumber,
      amount: Number(requestedAmountBigInt),
      feeAmount: Number(feeAmountBigInt),
      totalDebited: Number(totalDebitedBigInt),
      currency: 'AOA',
      destinationType,
      destinationAccount,
      newAvailableBalance: createdWithdrawal.newAvailableBalance,
      newLockedBalance: createdWithdrawal.newLockedBalance,
      message: 'Pedido de levantamento registado com sucesso. Os fundos foram reservados e estão em processamento pela tesouraria.'
    };
  }

  /**
   * Consulta os dados detalhados de uma ordem de levantamento (Anti-IDOR).
   *
   * @param {object} actingUser
   * @param {string} withdrawalId
   * @returns {Promise<object>}
   */
  async getWithdrawalById(actingUser, withdrawalId) {
    const withdrawal = await withdrawalsRepository.findById(withdrawalId);
    if (!withdrawal) {
      throw NotFoundError.resource('Levantamento', withdrawalId);
    }

    if (!withdrawalsPolicy.canViewWithdrawal(actingUser, withdrawal)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado aos dados deste levantamento.');
    }

    return withdrawal;
  }

  /**
   * Cancela uma solicitação de levantamento pendente antes de sua liquidação bancária,
   * libertando integralmente os fundos reservados de volta para o saldo disponível da carteira.
   *
   * @param {object} actingUser
   * @param {string} withdrawalId
   * @param {object} [context={}]
   * @returns {Promise<{ message: string }>}
   */
  async cancelWithdrawal(actingUser, withdrawalId, context = {}) {
    const withdrawal = await withdrawalsRepository.findById(withdrawalId);
    if (!withdrawal) {
      throw NotFoundError.resource('Levantamento', withdrawalId);
    }

    const cancelCheck = withdrawalsPolicy.canCancelWithdrawal(actingUser, withdrawal);
    if (!cancelCheck.allowed) {
      throw new ConflictError(cancelCheck.reason, 'WITHDRAWAL_CANCEL_BLOCKED');
    }

    const totalDebitedBigInt = BigInt(withdrawal.total_debited);

    await withTransaction(async (client) => {
      // Bloqueia a carteira
      const lockWalletSql = `SELECT id, ledger_balance, available_balance, locked_balance FROM wallets WHERE id = $1 FOR UPDATE;`;
      const walletRow = await queryOneClient(client, lockWalletSql, [withdrawal.wallet_id]);

      // Liberta fundos reservados
      const updatedBalances = balanceManager.releaseReservedFunds(walletRow, totalDebitedBigInt);

      await queryClient(
        client,
        `UPDATE wallets
         SET available_balance = $1,
             locked_balance = $2,
             updated_at = NOW() AT TIME ZONE 'UTC'
         WHERE id = $3;`,
        [updatedBalances.available_balance, updatedBalances.locked_balance, walletRow.id]
      );

      // Marca o levantamento como CANCELLED
      await withdrawalsRepository.updateStatus(withdrawalId, 'CANCELLED', {}, client);
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'STATUS_CHANGE',
        resourceType: 'WITHDRAWAL',
        resourceId: withdrawalId,
        oldValues: { status: withdrawal.status },
        newValues: { status: 'CANCELLED', releasedAmount: Number(totalDebitedBigInt) }
      });
    }

    return {
      message: 'Pedido de levantamento cancelado com sucesso. Os fundos reservados retornaram ao saldo disponível.'
    };
  }

  /**
   * Aprova e consolida a liquidação de um levantamento de fundos (Ação da Tesouraria / Operador Financeiro).
   * Desconta em definitivo os fundos reservados e lança a saída em partidas dobradas no livro-razão contábil.
   *
   * @param {object} actingUser - Operador Financeiro ou Administrador
   * @param {string} withdrawalId
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async approveWithdrawal(actingUser, withdrawalId, context = {}) {
    const authCheck = withdrawalsPolicy.canApproveWithdrawal(actingUser);
    if (!authCheck.allowed) {
      throw new AuthorizationError(authCheck.reason);
    }

    const withdrawal = await withdrawalsRepository.findById(withdrawalId);
    if (!withdrawal) {
      throw NotFoundError.resource('Levantamento', withdrawalId);
    }

    if (withdrawal.status !== 'REQUESTED' && withdrawal.status !== 'PROCESSING') {
      throw new ConflictError(`Apenas pedidos pendentes podem ser aprovados. Estado atual: [${withdrawal.status}].`);
    }

    const requestedAmountBigInt = BigInt(withdrawal.amount);
    const feeAmountBigInt = BigInt(withdrawal.fee_amount || 0);
    const totalDebitedBigInt = BigInt(withdrawal.total_debited);

    const settled = await withTransaction(async (client) => {
      // Bloqueia a carteira
      const lockWalletSql = `SELECT id, user_id, ledger_balance, available_balance, locked_balance FROM wallets WHERE id = $1 FOR UPDATE;`;
      const walletRow = await queryOneClient(client, lockWalletSql, [withdrawal.wallet_id]);

      // Consolida a saída permanente dos fundos retidos
      const updatedBalances = balanceManager.commitReservedFunds(walletRow, totalDebitedBigInt);

      await queryClient(
        client,
        `UPDATE wallets
         SET ledger_balance = $1,
             locked_balance = $2,
             updated_at = NOW() AT TIME ZONE 'UTC'
         WHERE id = $3;`,
        [updatedBalances.ledger_balance, updatedBalances.locked_balance, walletRow.id]
      );

      // Localiza as contas de razão para as partidas dobradas
      const userAccSql = `SELECT id FROM ledger_accounts WHERE user_id = $1 AND wallet_id = $2;`;
      const userAcc = await queryOneClient(client, userAccSql, [withdrawal.user_id, walletRow.id]);

      const sysSettlementSql = `SELECT id FROM ledger_accounts WHERE account_code = '1001-SETTLEMENT-POOL';`;
      const sysSettlement = await queryOneClient(client, sysSettlementSql);

      const sysRevenueSql = `SELECT id FROM ledger_accounts WHERE account_code = '4001-PLATFORM-REVENUE';`;
      const sysRevenue = await queryOneClient(client, sysRevenueSql);

      // Monta as pernas contábeis de saída
      const ledgerEntries = ledgerCalculator.calculateWithdrawalEntries({
        userLiabilityAccountId: userAcc.id,
        systemSettlementAccountId: sysSettlement.id,
        disbursedAmount: requestedAmountBigInt,
        systemRevenueAccountId: sysRevenue ? sysRevenue.id : null,
        feeAmount: feeAmountBigInt
      });

      const txReferenceCode = `LTX-WTH-${withdrawal.reference_number}`;
      const ledgerTx = await ledgerService.recordDoubleEntryTransaction(
        {
          referenceCode: txReferenceCode,
          idempotencyKey: `IDEMP-LTX-${withdrawal.idempotency_key}`,
          operationType: 'WITHDRAWAL',
          amount: totalDebitedBigInt,
          description: `Liquidação de levantamento bancário para ${withdrawal.destination_holder_name} (${withdrawal.destination_type})`,
          entries: ledgerEntries,
          metadata: {
            withdrawalId: withdrawal.id,
            destinationType: withdrawal.destination_type,
            destinationAccount: withdrawal.destination_account
          }
        },
        client
      );

      // Atualiza o levantamento para SETTLED
      const updatedWithdrawal = await withdrawalsRepository.updateStatus(
        withdrawal.id,
        'SETTLED',
        {
          reviewedBy: actingUser.id,
          settledAt: new Date(),
          ledgerTransactionId: ledgerTx.id
        },
        client
      );

      return {
        withdrawal: updatedWithdrawal,
        ledgerTransactionId: ledgerTx.id
      };
    });

    eventBus.publish(EVENT_TYPES.WITHDRAWAL_SETTLED, {
      withdrawalId: withdrawal.id,
      userId: withdrawal.user_id,
      amount: Number(requestedAmountBigInt),
      destinationType: withdrawal.destination_type
    }, { requestId: context.requestId });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'STATUS_CHANGE',
        resourceType: 'WITHDRAWAL',
        resourceId: withdrawal.id,
        oldValues: { status: withdrawal.status },
        newValues: { status: 'SETTLED', approvedBy: actingUser.id, ledgerTransactionId: settled.ledgerTransactionId }
      });
    }

    return {
      message: 'Levantamento liquidado com sucesso na compensação bancária.',
      withdrawal: settled.withdrawal
    };
  }

  /**
   * Rejeita formalmente um pedido de levantamento (Ação de Tesouraria/Admin).
   * Desfaz a reserva e devolve integralmente os valores ao saldo disponível.
   *
   * @param {object} actingUser
   * @param {string} withdrawalId
   * @param {string} reason
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async rejectWithdrawal(actingUser, withdrawalId, reason, context = {}) {
    const authCheck = withdrawalsPolicy.canRejectWithdrawal(actingUser);
    if (!authCheck.allowed) {
      throw new AuthorizationError(authCheck.reason);
    }

    const withdrawal = await withdrawalsRepository.findById(withdrawalId);
    if (!withdrawal) {
      throw NotFoundError.resource('Levantamento', withdrawalId);
    }

    if (withdrawal.status !== 'REQUESTED' && withdrawal.status !== 'PROCESSING') {
      throw new ConflictError(`Apenas pedidos pendentes podem ser rejeitados. Estado atual: [${withdrawal.status}].`);
    }

    const totalDebitedBigInt = BigInt(withdrawal.total_debited);

    const rejected = await withTransaction(async (client) => {
      // Bloqueia a carteira
      const lockWalletSql = `SELECT id, ledger_balance, available_balance, locked_balance FROM wallets WHERE id = $1 FOR UPDATE;`;
      const walletRow = await queryOneClient(client, lockWalletSql, [withdrawal.wallet_id]);

      // Liberta os fundos reservados de volta para o saldo disponível
      const updatedBalances = balanceManager.releaseReservedFunds(walletRow, totalDebitedBigInt);

      await queryClient(
        client,
        `UPDATE wallets
         SET available_balance = $1,
             locked_balance = $2,
             updated_at = NOW() AT TIME ZONE 'UTC'
         WHERE id = $3;`,
        [updatedBalances.available_balance, updatedBalances.locked_balance, walletRow.id]
      );

      // Marca o levantamento como REJECTED
      return withdrawalsRepository.updateStatus(
        withdrawal.id,
        'REJECTED',
        {
          reviewedBy: actingUser.id,
          failureReason: reason
        },
        client
      );
    });

    eventBus.publish(EVENT_TYPES.WITHDRAWAL_REJECTED, {
      withdrawalId: withdrawal.id,
      userId: withdrawal.user_id,
      reason,
      rejectedBy: actingUser.id
    }, { requestId: context.requestId });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'STATUS_CHANGE',
        resourceType: 'WITHDRAWAL',
        resourceId: withdrawal.id,
        oldValues: { status: withdrawal.status },
        newValues: { status: 'REJECTED', reason, rejectedBy: actingUser.id }
      });
    }

    return {
      message: 'Pedido de levantamento rejeitado. Os fundos reservados foram devolvidos ao saldo disponível.',
      withdrawal: rejected
    };
  }

  /**
   * Consulta o histórico paginado de levantamentos do utilizador autenticado.
   *
   * @param {object} user - Utilizador autenticado (req.user)
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listUserWithdrawals(user, filters, paginationParams) {
    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await withdrawalsRepository.listUserWithdrawals(user.id, filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }

  /**
   * Lista a fila geral de levantamentos da plataforma para operadores financeiros.
   *
   * @param {object} actingUser
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listAllWithdrawals(actingUser, filters, paginationParams) {
    const authCheck = withdrawalsPolicy.canApproveWithdrawal(actingUser);
    if (!authCheck.allowed) {
      throw new AuthorizationError(authCheck.reason);
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await withdrawalsRepository.listAllWithdrawals(filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }
}

// Instância singleton do serviço de levantamentos
const withdrawalsService = new WithdrawalsService();

module.exports = withdrawalsService;