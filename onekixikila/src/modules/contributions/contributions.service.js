// =============================================================================
// modules/contributions/contributions.service.js
// =============================================================================

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
  async payContribution(actingUser, paymentData, context = {}) {
    const {
      obligationId,
      paymentMethod = 'INTERNAL_WALLET',
      idempotencyKey: providedKey,
      phoneNumber = null,
      notes = null
    } = paymentData;

    const obligation = await contributionsRepository.findObligationWithDetails(obligationId);
    if (!obligation) {
      throw NotFoundError.resource('Obrigação de Quota', obligationId);
    }

    const policyCheck = contributionsPolicy.canPayContribution(actingUser, obligation);
    if (!policyCheck.allowed) {
      const err = new ConflictError(policyCheck.reason, 'CONTRIBUTION_PAYMENT_BLOCKED');
      err.statusCode = policyCheck.statusCode || 409;
      err.status = err.statusCode;
      throw err;
    }

    const baseQuotaAmount = BigInt(obligation.expected_amount);
    const assessedFee = BigInt(obligation.late_fee_assessed || 0);
    const totalRequired = baseQuotaAmount + assessedFee;

    const idempotencyKey = providedKey
      ? financialIdempotency.validateKey(providedKey)
      : financialIdempotency.generateKey('CONTRIB', obligationId, obligation.round_number);

    if (paymentMethod === 'INTERNAL_WALLET') {
      const walletSolvency = contributionsPolicy.canPayWithInternalWallet(obligation, totalRequired);
      if (!walletSolvency.allowed) {
        const err = new ConflictError(walletSolvency.reason, 'INSUFFICIENT_WALLET_FUNDS');
        err.statusCode = walletSolvency.statusCode || 402;
        err.status = err.statusCode;
        throw err;
      }

      const contribution = await withTransaction(async (client) => {
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

        const updatedBalances = balanceManager.directDebitFunds(walletRow, totalRequired);

        await queryClient(
          client,
          `UPDATE wallets
           SET ledger_balance = $1,
               available_balance = $2,
               locked_balance = $3,
               updated_at = NOW() AT TIME ZONE 'UTC'
           WHERE id = $4;`,
          [
            updatedBalances.ledger_balance,
            updatedBalances.available_balance,
            updatedBalances.locked_balance,
            walletRow.id
          ]
        );

        const personalAccountQuery = `SELECT id FROM ledger_accounts WHERE user_id = $1 AND wallet_id = $2;`;
        const personalAccount = await queryOneClient(client, personalAccountQuery, [
          obligation.user_id,
          walletRow.id
        ]);

        const systemSettlementQuery = `SELECT id FROM ledger_accounts WHERE account_code = '1001-SETTLEMENT-POOL';`;
        const systemSettlementAccount = await queryOneClient(client, systemSettlementQuery);

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

    const targetPhone = phoneNumber || actingUser.phoneNumber;
    if (!targetPhone) {
      throw ValidationError.fieldRequired('phoneNumber');
    }

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

    const adapter = providerFactory.getProvider(paymentMethod.toLowerCase());
    const merchantReference = `PAY-KQ-${initiatedContribution.id.slice(0, 8)}-${Date.now()}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

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

  async listGroupContributions(actingUser, groupId, filters, paginationParams) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await contributionsRepository.listGroupContributions(groupId, filters, {
      limit,
      offset
    });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }

  async listUserContributions(user, filters, paginationParams) {
    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await contributionsRepository.listUserContributions(user.id, filters, {
      limit,
      offset
    });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }
}

const contributionsService = new ContributionsService();

module.exports = contributionsService;<