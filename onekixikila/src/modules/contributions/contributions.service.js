const contributionsRepository = require('./contributions.repository');
const contributionsPolicy = require('./contributions.policy');
const groupsRepository = require('../groups/groups.repository');
const balanceManager = require('../../shared/finance/balance');
const financialIdempotency = require('../../shared/finance/idempotency');
const { withTransaction } = require('../../database/transaction');
const { queryOneClient, queryClient } = require('../../database/query');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const providerFactory = require('../../payments/providers/provider-factory');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço de regras de negócio para a Liquidação, Gestão e Conciliação de Contribuições
 * e Quotas de Kixikila na plataforma OneKixikila.
 */
class ContributionsService {
  /**
   * Executa a liquidação de uma quota de Kixikila.
   * Suporta pagamento imediato debitando da carteira digital interna em Kwanzas (com dupla partida no livro-razão)
   * ou geração de pedido de cobrança em gateway externo (Multicaixa Express, Unitel Money ou e-Kwanza).
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} paymentData - Dados validados por payContributionSchema
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async payContribution(actingUser, paymentData, context = {}) {
    const {
      obligationId,
      paymentMethod = 'INTERNAL_WALLET',
      idempotencyKey: providedKey,
      phoneNumber = null,
      notes = null
    } = paymentData;

    // 1. Obtém os detalhes consolidados da obrigação
    const obligation = await contributionsRepository.findObligationWithDetails(obligationId);
    if (!obligation) {
      throw NotFoundError.resource('Obrigação de Quota', obligationId);
    }

    // 2. Validação da política de pagamento
    const policyCheck = contributionsPolicy.canPayContribution(actingUser, obligation);
    if (!policyCheck.allowed) {
      const err = new ConflictError(policyCheck.reason, 'CONTRIBUTION_PAYMENT_BLOCKED');
      err.statusCode = policyCheck.statusCode || 409;
      err.status = err.statusCode;
      throw err;
    }

    // 3. Cálculo dos montantes devidos em Kwanzas inteiros (AOA)
    const baseQuotaAmount = BigInt(obligation.expected_amount);
    const assessedFee = BigInt(obligation.late_fee_assessed || 0);
    const totalRequired = baseQuotaAmount + assessedFee;

    // 4. Gestão da chave de idempotência
    const idempotencyKey = providedKey
      ? financialIdempotency.validateKey(providedKey)
      : financialIdempotency.generateKey('CONTRIB', obligationId, obligation.round_number);

    // --------------------------------------------------------------------------
    // FLUXO A: Liquidação imediata através da Carteira Interna (INTERNAL_WALLET)
    // --------------------------------------------------------------------------
    if (paymentMethod === 'INTERNAL_WALLET') {
      const walletSolvency = contributionsPolicy.canPayWithInternalWallet(obligation, totalRequired);
      if (!walletSolvency.allowed) {
        const err = new ConflictError(walletSolvency.reason, 'INSUFFICIENT_WALLET_FUNDS');
        err.statusCode = walletSolvency.statusCode || 402;
        err.status = err.statusCode;
        throw err;
      }

      const contribution = await withTransaction(async (client) => {
        // Bloqueio pessimista de concorrência (SELECT ... FOR UPDATE) na carteira do pagador
        const walletQuery = `
          SELECT id, user_id, ledger_balance, available_balance, locked_balance, status
          FROM wallets
          WHERE id = $1
          FOR UPDATE;
        `;
        const walletRow = await queryOneClient(client, walletQuery, [obligation.wallet_id]);
        if (!walletRow) {
          throw NotFoundError.wallet(obligation.wallet_id);
        }

        // Calcula os novos saldos aplicando o débito imediato com garantia de não-negatividade
        const updatedBalances = balanceManager.directDebitFunds(walletRow, totalRequired);

        // Atualiza a carteira digital
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

        // Localiza as contas de razão para o lançamento contábil em partidas dobradas
        const personalAccountQuery = `SELECT id FROM ledger_accounts WHERE user_id = $1 AND wallet_id = $2;`;
        const personalAccount = await queryOneClient(client, personalAccountQuery, [obligation.user_id, walletRow.id]);

        const systemSettlementQuery = `SELECT id FROM ledger_accounts WHERE account_code = '1001-SETTLEMENT-POOL';`;
        const systemSettlementAccount = await queryOneClient(client, systemSettlementQuery);

        // Cria a transação de cabeçalho no Livro-Razão
        const ledgerTxQuery = `
          INSERT INTO ledger_transactions (
            reference_code,
            idempotency_key,
            operation_type,
            status,
            amount,
            currency,
            description,
            metadata
          )
          VALUES ($1, $2, 'CONTRIBUTION_PAYMENT', 'POSTED', $3, 'AOA', $4, $5::jsonb)
          RETURNING id;
        `;

        const txReferenceCode = `LTX-KQ-${obligation.group_id.slice(0, 8)}-${Date.now()}`;
        const txMetadata = {
          groupId: obligation.group_id,
          scheduleId: obligation.schedule_id,
          obligationId,
          cycleNumber: obligation.cycle_number,
          roundNumber: obligation.round_number,
          baseQuotaAmount: Number(baseQuotaAmount),
          lateFeeAssessed: Number(assessedFee)
        };

        const ledgerTx = await queryOneClient(client, ledgerTxQuery, [
          txReferenceCode,
          `IDEMP-LTX-${idempotencyKey}`,
          Number(totalRequired),
          `Liquidação de quota da Kixikila - Grupo ${obligation.group_name} (Rodada ${obligation.round_number})`,
          JSON.stringify(txMetadata)
        ]);

        // Lança as partidas dobradas: Débito no Passivo do Utilizador e Crédito no Ativo transitório
        if (personalAccount && systemSettlementAccount) {
          await queryClient(
            client,
            `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount, currency, sequence)
             VALUES ($1, $2, 'DEBIT', $3, 'AOA', 1);`,
            [ledgerTx.id, personalAccount.id, Number(totalRequired)]
          );

          await queryClient(
            client,
            `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount, currency, sequence)
             VALUES ($1, $2, 'CREDIT', $3, 'AOA', 2);`,
            [ledgerTx.id, systemSettlementAccount.id, Number(totalRequired)]
          );
        }

        // Quita a obrigação em contribution_obligations
        await contributionsRepository.settleObligation(
          obligationId,
          {
            paidAmount: Number(baseQuotaAmount),
            lateFee: Number(assessedFee),
            status: 'PAID',
            paidAt: new Date()
          },
          client
        );

        // Regista formalmente a contribuição em contributions com status CONFIRMED
        const createdContrib = await contributionsRepository.createContribution(
          {
            obligationId,
            scheduleId: obligation.schedule_id,
            groupId: obligation.group_id,
            userId: obligation.user_id,
            amount: Number(baseQuotaAmount),
            feeAmount: Number(assessedFee),
            totalDebited: Number(totalRequired),
            currency: 'AOA',
            status: 'CONFIRMED',
            idempotencyKey,
            paymentMethod: 'INTERNAL_WALLET',
            ledgerTransactionId: ledgerTx.id,
            confirmedAt: new Date(),
            notes
          },
          client
        );

        return {
          contribution: createdContrib,
          newWalletBalance: updatedBalances.available_balance
        };
      });

      // Emite o evento assíncrono de quota liquidada
      eventBus.publish(
        EVENT_TYPES.CONTRIBUTION_PAID,
        {
          contributionId: contribution.contribution.id,
          obligationId,
          groupId: obligation.group_id,
          userId: obligation.user_id,
          amount: Number(totalRequired),
          paymentMethod: 'INTERNAL_WALLET'
        },
        { requestId: context.requestId }
      );

      if (context.recordAudit) {
        await context.recordAudit({
          action: 'FINANCIAL_TRANSACTION',
          resourceType: 'CONTRIBUTION',
          resourceId: contribution.contribution.id,
          metadata: {
            groupId: obligation.group_id,
            obligationId,
            totalDebited: Number(totalRequired),
            paymentMethod: 'INTERNAL_WALLET'
          }
        });
      }

      return {
        success: true,
        status: 'CONFIRMED',
        message: 'Quota de Kixikila liquidada com sucesso através da sua carteira interna.',
        contributionId: contribution.contribution.id,
        totalDebited: Number(totalRequired),
        newWalletAvailableBalance: contribution.newWalletBalance
      };
    }

    // --------------------------------------------------------------------------
    // FLUXO B: Geração de cobrança em Gateway Externo (MCX, Unitel Money, e-Kwanza)
    // --------------------------------------------------------------------------
    const targetPhone = phoneNumber || actingUser.phoneNumber;
    if (!targetPhone) {
      throw ValidationError.fieldRequired('phoneNumber');
    }

    // Cria o registo preliminar da contribuição no estado INITIATED
    const initiatedContribution = await contributionsRepository.createContribution({
      obligationId,
      scheduleId: obligation.schedule_id,
      groupId: obligation.group_id,
      userId: obligation.user_id,
      amount: Number(baseQuotaAmount),
      feeAmount: Number(assessedFee),
      totalDebited: Number(totalRequired),
      currency: 'AOA',
      status: 'INITIATED',
      idempotencyKey,
      paymentMethod,
      notes
    });

    // Inicia o pedido no adaptador do prestador correspondente
    const adapter = providerFactory.getProvider(paymentMethod.toLowerCase());
    const merchantReference = `PAY-KQ-${initiatedContribution.id.slice(0, 8)}-${Date.now()}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

    const gatewayResult = await adapter.initiatePayment({
      merchantReference,
      amount: Number(totalRequired),
      currency: 'AOA',
      phoneNumber: targetPhone,
      description: `Quota Kixikila - ${obligation.group_name} (Rodada ${obligation.round_number})`,
      expiresAt
    });

    return {
      success: true,
      status: 'PROCESSING',
      message: 'Ordem de pagamento enviada ao prestador. Conclua a autorização no seu telemóvel.',
      contributionId: initiatedContribution.id,
      merchantReference,
      providerTransactionId: gatewayResult.providerTransactionId,
      qrPayload: gatewayResult.qrPayload || null,
      expiresAt: expiresAt.toISOString()
    };
  }

  /**
   * Consulta os detalhes de uma contribuição individual com validação de permissões.
   *
   * @param {object} actingUser
   * @param {string} contributionId
   * @returns {Promise<object>}
   */
  async getContributionById(actingUser, contributionId) {
    const contribution = await contributionsRepository.findById(contributionId);
    if (!contribution) {
      throw NotFoundError.resource('Contribuição', contributionId);
    }

    const group = await groupsRepository.findById(contribution.group_id);
    const isLeader = group && group.leader_id === actingUser.id;

    if (!contributionsPolicy.canViewContribution(actingUser, contribution, isLeader)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado aos dados desta contribuição.');
    }

    return contribution;
  }

  /**
   * Dispensa ou perdoa formalmente a multa de mora aplicada a uma obrigação (Decisão de Liderança).
   *
   * @param {object} actingUser
   * @param {string} obligationId
   * @param {string} reason - Justificativa da dispensa
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async waiveLateFee(actingUser, obligationId, reason, context = {}) {
    const obligation = await contributionsRepository.findObligationWithDetails(obligationId);
    if (!obligation) {
      throw NotFoundError.resource('Obrigação de Quota', obligationId);
    }

    const waiveCheck = contributionsPolicy.canWaiveLateFee(actingUser, obligation);
    if (!waiveCheck.allowed) {
      throw new AuthorizationError(waiveCheck.reason);
    }

    const updated = await contributionsRepository.waiveLateFee(obligationId);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'CONTRIBUTION_OBLIGATION',
        resourceId: obligationId,
        oldValues: { lateFeeAssessed: obligation.late_fee_assessed },
        newValues: { lateFeeAssessed: 0, waiverReason: reason, waivedBy: actingUser.id }
      });
    }

    return {
      message: 'Multa de mora dispensada com sucesso pela liderança do grupo.',
      obligation: updated
    };
  }

  /**
   * Lista as contribuições financeiras arrecadadas em determinado grupo com paginação e filtros.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listGroupContributions(actingUser, groupId, filters, paginationParams) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await contributionsRepository.listGroupContributions(groupId, filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }

  /**
   * Lista o histórico pessoal de quotas pagas pelo utilizador em todos os seus grupos.
   *
   * @param {object} user - Utilizador autenticado (req.user)
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listUserContributions(user, filters, paginationParams) {
    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await contributionsRepository.listUserContributions(user.id, filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }
}

// Instância singleton do serviço de contribuições
const contributionsService = new ContributionsService();

module.exports = contributionsService;