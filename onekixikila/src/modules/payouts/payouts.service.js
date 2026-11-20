const payoutsRepository = require('./payouts.repository');
const payoutsPolicy = require('./payouts.policy');
const groupsRepository = require('../groups/groups.repository');
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
 * Serviço orquestrador de regras de negócio para Desembolsos e Payouts de Kixikila.
 * Responsável pela validação do fundo arrecadado na rodada, entrega do bolo financeiro
 * ao beneficiário da vez, liquidação contábil no livro-razão em partidas dobradas,
 * aplicação de retenções cautelares e auditoria de conformidade.
 */
class PayoutsService {
  /**
   * Executa a liquidação do montante acumulado na rodada da Kixikila para o beneficiário atribuído.
   * Credita os fundos na carteira digital do membro beneficiário com registro atômico no livro-razão.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} payoutData - Parâmetros da operação { rotationId, payoutMethod, idempotencyKey, notes }
   * @param {object} [context={}] - Contexto de auditoria e rastreamento HTTP
   * @returns {Promise<object>}
   */
  async executePayout(actingUser, payoutData, context = {}) {
    const {
      rotationId,
      payoutMethod = 'INTERNAL_WALLET',
      idempotencyKey: providedKey,
      notes = null
    } = payoutData;

    if (!rotationId) {
      throw ValidationError.fieldRequired('rotationId');
    }

    // 1. Obtém os detalhes consolidados do turno de rotação e beneficiário atribuído
    const rotation = await payoutsRepository.findRotationWithDetails(rotationId);
    if (!rotation) {
      throw NotFoundError.resource('Turno de Rotação', rotationId);
    }

    // 2. Validação da política de autorização e prontidão do bolo
    const policyCheck = payoutsPolicy.canExecutePayout(actingUser, rotation);
    if (!policyCheck.allowed) {
      const err = new ConflictError(policyCheck.reason, 'PAYOUT_EXECUTION_BLOCKED');
      err.statusCode = policyCheck.statusCode || 409;
      err.status = err.statusCode;
      throw err;
    }

    // 3. Apura o montante total arrecadado das quotas confirmadas da rodada
    const collectedAmount = await payoutsRepository.getPoolCollectedAmount(rotation.schedule_id);
    const targetAmount = BigInt(rotation.pool_target_amount);

    if (collectedAmount < targetAmount) {
      throw new ConflictError(
        `O fundo acumulado (${Number(collectedAmount).toLocaleString('pt-AO')} Kz) ainda não atingiu o valor total previsto para este turno (${Number(targetAmount).toLocaleString('pt-AO')} Kz). Todas as quotas devem estar quitadas antes do desembolso.`,
        'INCOMPLETE_POOL_COLLECTION'
      );
    }

    // 4. Gestão da chave de idempotência financeira
    const idempotencyKey = providedKey
      ? financialIdempotency.validateKey(providedKey)
      : financialIdempotency.generateKey('PAYOUT', rotationId, rotation.cycle_number);

    // 5. Execução transacional atômica da liquidação
    const result = await withTransaction(async (client) => {
      // Bloqueio pessimista de concorrência na carteira do beneficiário
      const walletQuery = `
        SELECT id, user_id, ledger_balance, available_balance, locked_balance, status
        FROM wallets
        WHERE id = $1
        FOR UPDATE;
      `;
      const walletRow = await queryOneClient(client, walletQuery, [rotation.beneficiary_wallet_id]);
      if (!walletRow) {
        throw NotFoundError.wallet(rotation.beneficiary_wallet_id);
      }

      if (walletRow.status !== 'ACTIVE') {
        throw new ConflictError(
          `A carteira digital do beneficiário encontra-se no estado [${walletRow.status}]. Desembolso bloqueado.`,
          'BENEFICIARY_WALLET_INACTIVE'
        );
      }

      // Calcula os novos saldos creditando o montante do bolo
      const updatedBalances = balanceManager.creditFunds(walletRow, targetAmount);

      // Atualiza os saldos da carteira do beneficiário
      await queryClient(
        client,
        `UPDATE wallets
         SET ledger_balance = $1,
             available_balance = $2,
             locked_balance = $3,
             updated_at = NOW() AT TIME ZONE 'UTC'
         WHERE id = $4;`,
        [updatedBalances.ledger_balance, updatedBalances.available_balance, updatedBalances.locked_balance, walletRow.id]
      );

      // Localiza as contas de razão para o lançamento em partidas dobradas
      const sysAccountQuery = `SELECT id FROM ledger_accounts WHERE account_code = '1001-SETTLEMENT-POOL';`;
      const sysAccount = await queryOneClient(client, sysAccountQuery);

      const userAccountQuery = `SELECT id FROM ledger_accounts WHERE user_id = $1 AND wallet_id = $2;`;
      const userAccount = await queryOneClient(client, userAccountQuery, [rotation.beneficiary_user_id, walletRow.id]);

      // Monta as pernas contábeis via ledgerCalculator
      const ledgerEntries = ledgerCalculator.calculateRotationPayoutEntries({
        poolSettlementAccountId: sysAccount.id,
        beneficiaryLiabilityAccountId: userAccount.id,
        payoutAmount: targetAmount
      });

      const txReferenceCode = `LTX-PAYOUT-${rotation.group_id.slice(0, 8)}-${Date.now()}`;
      const txMetadata = {
        groupId: rotation.group_id,
        rotationId,
        scheduleId: rotation.schedule_id,
        cycleNumber: rotation.cycle_number,
        positionOrder: rotation.position_order,
        beneficiaryUserId: rotation.beneficiary_user_id,
        beneficiaryName: rotation.beneficiary_name
      };

      // Cria a transação do Livro-Razão
      const ledgerTx = await ledgerService.recordDoubleEntryTransaction(
        {
          referenceCode: txReferenceCode,
          idempotencyKey: `IDEMP-LTX-${idempotencyKey}`,
          operationType: 'ROTATION_PAYOUT',
          amount: targetAmount,
          description: `Desembolso do bolo da Kixikila - Grupo ${rotation.group_name} (Ciclo ${rotation.cycle_number}, Mão ${rotation.position_order})`,
          entries: ledgerEntries,
          metadata: txMetadata
        },
        client
      );

      // Atualiza o turno de rotação para PAID_OUT
      const updatedRotation = await payoutsRepository.updateRotationStatus(
        rotationId,
        'PAID_OUT',
        {
          actualPayoutDate: new Date(),
          actualDisbursedAmount: Number(targetAmount)
        },
        client
      );

      // Vincula a transação contábil à atribuição do beneficiário
      await payoutsRepository.linkLedgerTransactionToAssignment(
        rotation.assignment_id,
        ledgerTx.id,
        notes,
        client
      );

      return {
        rotation: updatedRotation,
        ledgerTransactionId: ledgerTx.id,
        disbursedAmount: Number(targetAmount),
        beneficiaryUserId: rotation.beneficiary_user_id,
        beneficiaryWalletId: walletRow.id,
        newAvailableBalance: updatedBalances.available_balance
      };
    });

    // Emissão do evento de domínio
    eventBus.publish(
      EVENT_TYPES.ROTATION_PAYOUT_SETTLED,
      {
        rotationId,
        groupId: rotation.group_id,
        cycleNumber: rotation.cycle_number,
        positionOrder: rotation.position_order,
        beneficiaryUserId: result.beneficiaryUserId,
        amount: result.disbursedAmount,
        ledgerTransactionId: result.ledgerTransactionId
      },
      { requestId: context.requestId }
    );

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'FINANCIAL_TRANSACTION',
        resourceType: 'ROTATION_PAYOUT',
        resourceId: rotationId,
        metadata: {
          groupId: rotation.group_id,
          amount: result.disbursedAmount,
          beneficiaryUserId: result.beneficiaryUserId,
          ledgerTransactionId: result.ledgerTransactionId
        }
      });
    }

    return {
      success: true,
      status: 'SETTLED',
      message: `Bolo da Kixikila desembolsado com sucesso para ${rotation.beneficiary_name}.`,
      rotationId,
      disbursedAmount: result.disbursedAmount,
      currency: rotation.currency || 'AOA',
      ledgerTransactionId: result.ledgerTransactionId,
      beneficiaryAvailableBalance: result.newAvailableBalance
    };
  }

  /**
   * Consulta os dados detalhados de um turno de desembolso pelo seu identificador primário UUID.
   *
   * @param {object} actingUser
   * @param {string} payoutId
   * @returns {Promise<object>}
   */
  async getPayoutById(actingUser, payoutId) {
    const payout = await payoutsRepository.findRotationWithDetails(payoutId);
    if (!payout) {
      throw NotFoundError.resource('Desembolso de Kixikila', payoutId);
    }

    const group = await groupsRepository.findById(payout.group_id);
    const isLeader = group && (group.leader_id === actingUser.id || group.creator_id === actingUser.id);

    if (!payoutsPolicy.canViewPayout(actingUser, payout, isLeader)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado aos dados deste desembolso.');
    }

    return payout;
  }

  /**
   * Retém preventivamente ou suspende temporariamente um desembolso em caso de litígio ou disputa.
   *
   * @param {object} actingUser
   * @param {string} payoutId
   * @param {string} reason
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async holdPayout(actingUser, payoutId, reason, context = {}) {
    const payout = await payoutsRepository.findRotationWithDetails(payoutId);
    if (!payout) {
      throw NotFoundError.resource('Desembolso de Kixikila', payoutId);
    }

    const group = await groupsRepository.findById(payout.group_id);
    const check = payoutsPolicy.canHoldPayout(actingUser, group, payout);
    if (!check.allowed) {
      throw new AuthorizationError(check.reason);
    }

    const updated = await payoutsRepository.updateRotationStatus(payoutId, 'SKIPPED');

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'ROTATION_PAYOUT_HOLD',
        resourceId: payoutId,
        oldValues: { status: payout.status },
        newValues: { status: 'SKIPPED', reason, heldBy: actingUser.id }
      });
    }

    return {
      message: 'Desembolso retido preventivamente. O turno foi colocado em pausa para resolução.',
      payout: updated
    };
  }

  /**
   * Liberta um desembolso previamente retido de volta para o estado pronto para pagamento.
   *
   * @param {object} actingUser
   * @param {string} payoutId
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async releasePayout(actingUser, payoutId, context = {}) {
    const payout = await payoutsRepository.findRotationWithDetails(payoutId);
    if (!payout) {
      throw NotFoundError.resource('Desembolso de Kixikila', payoutId);
    }

    const group = await groupsRepository.findById(payout.group_id);
    const check = payoutsPolicy.canReleasePayout(actingUser, group, payout);
    if (!check.allowed) {
      throw new AuthorizationError(check.reason);
    }

    const updated = await payoutsRepository.updateRotationStatus(payoutId, 'READY_FOR_PAYOUT');

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'ROTATION_PAYOUT_RELEASE',
        resourceId: payoutId,
        oldValues: { status: payout.status },
        newValues: { status: 'READY_FOR_PAYOUT', releasedBy: actingUser.id }
      });
    }

    return {
      message: 'Desembolso libertado com sucesso para liquidação.',
      payout: updated
    };
  }

  /**
   * Lista o histórico paginado de desembolsos de determinado grupo.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listGroupPayouts(actingUser, groupId, filters, paginationParams) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await payoutsRepository.listGroupPayouts(groupId, filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }

  /**
   * Lista os recebimentos de bolo de Kixikila do próprio utilizador autenticado em todos os seus grupos.
   *
   * @param {object} user - Utilizador autenticado (req.user)
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listUserPayouts(user, filters, paginationParams) {
    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await payoutsRepository.listUserPayouts(user.id, filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }
}

// Instância singleton do serviço de desembolsos
const payoutsService = new PayoutsService();

module.exports = payoutsService;