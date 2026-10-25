const ledgerRepository = require('./ledger.repository');
const ledgerPolicy = require('./ledger.policy');
const ledgerCalculator = require('./ledger-calculator');
const ledgerIntegrityService = require('./ledger-integrity');
const financialIdempotency = require('../../shared/finance/idempotency');
const { withTransaction } = require('../../database/transaction');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço orquestrador de regras de negócio para o Livro-Razão (Ledger) em Partidas Dobradas
 * da plataforma OneKixikila.
 */
class LedgerService {
  /**
   * Grava atomicamente uma transação contábil completa (cabeçalho + pernas de débito/crédito + atualização de saldos de contas).
   *
   * @param {object} txParams
   * @param {string} txParams.referenceCode - Código único de referência
   * @param {string} txParams.idempotencyKey - Chave única de idempotência
   * @param {string} txParams.operationType - 'DEPOSIT', 'WITHDRAWAL', 'CONTRIBUTION_PAYMENT', etc.
   * @param {number|bigint} txParams.amount - Montante total em Kwanzas inteiros (AOA)
   * @param {string} txParams.description - Justificativa descritiva
   * @param {Array<{ accountId: string, direction: 'DEBIT'|'CREDIT', amount: number|bigint }>} txParams.entries - Pernas contábeis
   * @param {object} [txParams.metadata={}]
   * @param {string|null} [txParams.relatedTransactionId=null]
   * @param {import('pg').PoolClient} [externalClient=null] - Conexão transacional opcional
   * @returns {Promise<object>} Transação gravada
   */
  async recordDoubleEntryTransaction(txParams, externalClient = null) {
    const {
      referenceCode,
      idempotencyKey,
      operationType,
      amount,
      description,
      entries,
      metadata = {},
      relatedTransactionId = null
    } = txParams;

    // 1. Validação estrita da equação contábil das partidas dobradas (Débito === Crédito)
    const balanceCheck = ledgerPolicy.validateDoubleEntryBalance(entries);
    if (!balanceCheck.balanced) {
      throw new ConflictError(balanceCheck.reason, 'UNBALANCED_DOUBLE_ENTRY');
    }

    const runner = async (client) => {
      // 2. Criação do cabeçalho da transação
      const header = await ledgerRepository.createTransactionHeader(
        {
          referenceCode,
          idempotencyKey,
          operationType,
          status: 'POSTED',
          amount: Number(BigInt(amount)),
          currency: 'AOA',
          description,
          metadata,
          relatedTransactionId
        },
        client
      );

      // 3. Preparação das pernas com número sequencial
      let seq = 1;
      const preparedEntries = entries.map((entry) => ({
        transactionId: header.id,
        accountId: entry.accountId,
        direction: entry.direction,
        amount: Number(BigInt(entry.amount)),
        sequence: seq++
      }));

      // 4. Inserção em lote dos lançamentos de débito e crédito
      await ledgerRepository.createEntriesBatch(preparedEntries, client);

      // 5. Atualização atómica dos saldos cacheados de cada conta envolvida
      for (const entry of preparedEntries) {
        const delta = entry.direction === 'DEBIT' ? entry.amount : -entry.amount;
        await ledgerRepository.updateAccountBalance(entry.accountId, delta, client);
      }

      return header;
    };

    if (externalClient) {
      return runner(externalClient);
    }

    return withTransaction(runner);
  }

  /**
   * Executa uma transação de estorno contábil compensatório auditado (Reversal).
   * Inverte com precisão matemática os débitos e créditos da transação original,
   * preservando a imutabilidade histórica do razão.
   *
   * @param {object} actingUser - Auditor ou Administrador
   * @param {string} originalTransactionId - UUID da transação original a estornar
   * @param {string} reason - Motivo formal do estorno
   * @param {object} [context={}]
   * @returns {Promise<object>} Nova transação de estorno criada
   */
  async reverseTransaction(actingUser, originalTransactionId, reason, context = {}) {
    if (!ledgerPolicy.canAuditLedger(actingUser)) {
      throw AuthorizationError.insufficientPermissions(actingUser ? actingUser.role : 'ANONYMOUS', [
        'ADMIN',
        'AUDITOR',
        'FINANCIAL_OPERATOR'
      ]);
    }

    const originalTx = await ledgerRepository.findTransactionById(originalTransactionId);
    if (!originalTx) {
      throw NotFoundError.resource('Transação do Livro-Razão', originalTransactionId);
    }

    if (originalTx.operation_type === 'REFUND_REVERSAL') {
      throw new ConflictError('Não é permitido estornar uma transação que já representa um estorno compensatório.');
    }

    // Calcula os lançamentos inversos
    const originalEntries = Array.isArray(originalTx.entries) ? originalTx.entries : [];
    const reversalEntries = ledgerCalculator.calculateReversalEntries(originalEntries);

    const reversalRefCode = `REV-${originalTx.reference_code.slice(0, 16)}-${Date.now()}`;
    const reversalIdempotencyKey = financialIdempotency.generateKey('REV', originalTx.id, Date.now());

    const reversalTx = await this.recordDoubleEntryTransaction({
      referenceCode: reversalRefCode,
      idempotencyKey: reversalIdempotencyKey,
      operationType: 'REFUND_REVERSAL',
      amount: originalTx.amount,
      description: `Estorno compensatório auditado: ${reason} (Ref original: ${originalTx.reference_code})`,
      entries: reversalEntries,
      relatedTransactionId: originalTx.id,
      metadata: {
        reversedByUserId: actingUser.id,
        reason,
        originalReferenceCode: originalTx.reference_code
      }
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'FINANCIAL_TRANSACTION',
        resourceType: 'LEDGER_TRANSACTION',
        resourceId: reversalTx.id,
        metadata: {
          originalTransactionId: originalTx.id,
          reversalReferenceCode: reversalRefCode,
          reason
        }
      });
    }

    return {
      message: 'Estorno contábil compensatório lançado e balanceado com sucesso no livro-razão.',
      reversalTransaction: reversalTx
    };
  }

  /**
   * Consulta os detalhes de uma transação contábil pelo seu UUID.
   *
   * @param {object} actingUser
   * @param {string} transactionId
   * @returns {Promise<object>}
   */
  async getTransactionById(actingUser, transactionId) {
    if (!ledgerPolicy.canAuditLedger(actingUser)) {
      throw AuthorizationError.insufficientPermissions(actingUser ? actingUser.role : 'ANONYMOUS', [
        'ADMIN',
        'AUDITOR',
        'FINANCIAL_OPERATOR'
      ]);
    }

    const tx = await ledgerRepository.findTransactionById(transactionId);
    if (!tx) {
      throw NotFoundError.resource('Transação do Livro-Razão', transactionId);
    }

    return tx;
  }

  /**
   * Consulta o extrato contábil dos lançamentos de determinada conta com paginação e validação Anti-IDOR.
   *
   * @param {object} actingUser
   * @param {string} accountCode
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async getAccountStatement(actingUser, accountCode, paginationParams) {
    const account = await ledgerRepository.findAccountByCode(accountCode);
    if (!account) {
      throw NotFoundError.resource('Conta do Livro-Razão', accountCode);
    }

    if (!ledgerPolicy.canViewLedgerAccount(actingUser, account)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado ao extrato desta conta contábil.');
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await ledgerRepository.getAccountStatement(account.id, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }

  /**
   * Dispara a auditoria de integridade e balanço do Livro-Razão do sistema.
   *
   * @param {object} actingUser
   * @returns {Promise<object>}
   */
  async runIntegrityAudit(actingUser) {
    if (!ledgerPolicy.canAuditLedger(actingUser)) {
      throw AuthorizationError.insufficientPermissions(actingUser ? actingUser.role : 'ANONYMOUS', [
        'ADMIN',
        'AUDITOR',
        'FINANCIAL_OPERATOR'
      ]);
    }

    return ledgerIntegrityService.verifySystemIntegrity();
  }
}

// Instância singleton do serviço do livro-razão
const ledgerService = new LedgerService();

module.exports = ledgerService;