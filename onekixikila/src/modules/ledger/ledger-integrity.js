const ledgerRepository = require('./ledger.repository');
const ledgerPolicy = require('./ledger.policy');
const { query } = require('../../database/query');
const ConflictError = require('../../shared/errors/conflict-error');

/**
 * Módulo de Auditoria Contínua e Integridade Contábil do Livro-Razão (Ledger Integrity Checker).
 * Executa verificações ativas e rotinas de detecção de anomalias contábeis:
 * - Validação global da equação das partidas dobradas (Total Débitos === Total Créditos)
 * - Identificação de transações individuais desbalanceadas
 * - Reconciliação do somatório de lançamentos de cada conta contra a coluna balance cacheada
 * - Conformidade da equação da carteira: available_balance + locked_balance = ledger_balance
 */
class LedgerIntegrityService {
  /**
   * Executa a auditoria completa de integridade contábil do sistema.
   *
   * @returns {Promise<{
   *   isBalanced: boolean,
   *   totalDebits: number,
   *   totalCredits: number,
   *   discrepancyCount: number,
   *   unbalancedTransactions: Array<object>,
   *   accountBalanceMismatches: Array<object>,
   *   walletEquationMismatches: Array<object>,
   *   auditedAt: string
   * }>}
   */
  async verifySystemIntegrity() {
    const auditedAt = new Date().toISOString();

    // 1. Auditoria global do razão (Total Débito vs Total Crédito de todos os tempos)
    const globalAudit = await ledgerRepository.auditDoubleEntryIntegrity();

    // 2. Localização de transações individuais com quebra de equilíbrio contábil
    const unbalancedTxSql = `
      SELECT 
        lt.id AS transaction_id,
        lt.reference_code,
        lt.operation_type,
        lt.status,
        lt.amount,
        COALESCE(SUM(CASE WHEN le.direction = 'DEBIT' THEN le.amount ELSE 0 END), 0)::bigint AS sum_debit,
        COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE 0 END), 0)::bigint AS sum_credit
      FROM ledger_transactions lt
      LEFT JOIN ledger_entries le ON le.transaction_id = lt.id
      WHERE lt.status = 'POSTED'
      GROUP BY lt.id
      HAVING COALESCE(SUM(CASE WHEN le.direction = 'DEBIT' THEN le.amount ELSE 0 END), 0) <>
             COALESCE(SUM(CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE 0 END), 0)
         OR COUNT(le.id) < 2;
    `;
    const unbalancedResult = await query(unbalancedTxSql);
    const unbalancedTransactions = unbalancedResult.rows.map((r) => ({
      transactionId: r.transaction_id,
      referenceCode: r.reference_code,
      operationType: r.operation_type,
      nominalAmount: Number(r.amount),
      sumDebit: Number(r.sum_debit),
      sumCredit: Number(r.sum_credit),
      difference: Math.abs(Number(r.sum_debit) - Number(r.sum_credit))
    }));

    // 3. Verificação de consistência entre a soma histórica dos lançamentos e a coluna balance em ledger_accounts
    const accountMismatchSql = `
      SELECT 
        la.id AS account_id,
        la.account_code,
        la.account_type,
        la.balance AS cached_balance,
        COALESCE(
          SUM(
            CASE 
              WHEN la.account_type IN ('ASSET', 'EXPENSE') THEN
                CASE WHEN le.direction = 'DEBIT' THEN le.amount ELSE -le.amount END
              ELSE
                CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE -le.amount END
            END
          ), 0
        )::bigint AS computed_balance
      FROM ledger_accounts la
      LEFT JOIN ledger_entries le ON le.account_id = la.id
      GROUP BY la.id
      HAVING la.balance <> COALESCE(
        SUM(
          CASE 
            WHEN la.account_type IN ('ASSET', 'EXPENSE') THEN
              CASE WHEN le.direction = 'DEBIT' THEN le.amount ELSE -le.amount END
            ELSE
              CASE WHEN le.direction = 'CREDIT' THEN le.amount ELSE -le.amount END
          END
        ), 0
      );
    `;
    const accountMismatchResult = await query(accountMismatchSql);
    const accountBalanceMismatches = accountMismatchResult.rows.map((r) => ({
      accountId: r.account_id,
      accountCode: r.account_code,
      accountType: r.account_type,
      cachedBalance: Number(r.cached_balance),
      computedBalance: Number(r.computed_balance),
      discrepancy: Math.abs(Number(r.cached_balance) - Number(r.computed_balance))
    }));

    // 4. Verificação de integridade da equação em todas as carteiras (available + locked = ledger)
    const walletEquationSql = `
      SELECT 
        id AS wallet_id,
        user_id,
        ledger_balance,
        available_balance,
        locked_balance
      FROM wallets
      WHERE (available_balance + locked_balance) <> ledger_balance
         OR available_balance < 0
         OR locked_balance < 0
         OR ledger_balance < 0;
    `;
    const walletMismatchResult = await query(walletEquationSql);
    const walletEquationMismatches = walletMismatchResult.rows.map((r) => ({
      walletId: r.wallet_id,
      userId: r.user_id,
      ledgerBalance: Number(r.ledger_balance),
      availableBalance: Number(r.available_balance),
      lockedBalance: Number(r.locked_balance),
      expectedLedger: Number(r.available_balance) + Number(r.locked_balance)
    }));

    const isGloballyBalanced =
      globalAudit.totalDebits === globalAudit.totalCredits &&
      unbalancedTransactions.length === 0 &&
      accountBalanceMismatches.length === 0 &&
      walletEquationMismatches.length === 0;

    return {
      isBalanced: isGloballyBalanced,
      totalDebits: Number(globalAudit.totalDebits),
      totalCredits: Number(globalAudit.totalCredits),
      discrepancyCount:
        globalAudit.discrepancyCount +
        unbalancedTransactions.length +
        accountBalanceMismatches.length +
        walletEquationMismatches.length,
      unbalancedTransactions,
      accountBalanceMismatches,
      walletEquationMismatches,
      auditedAt
    };
  }

  /**
   * Valida a integridade contábil de uma transação específica antes ou após a consolidação.
   * Lança ConflictError imediatamente se a transação for assimétrica.
   *
   * @param {string} transactionId
   */
  async assertTransactionBalance(transactionId) {
    const tx = await ledgerRepository.findTransactionById(transactionId);
    if (!tx) {
      throw new ConflictError(`Transação contábil [${transactionId}] não localizada para verificação.`);
    }

    const entries = Array.isArray(tx.entries) ? tx.entries : [];
    const validation = ledgerPolicy.validateDoubleEntryBalance(entries);

    if (!validation.balanced) {
      throw new ConflictError(
        `Falha de integridade contábil na transação [${tx.reference_code}]: ${validation.reason}`,
        'UNBALANCED_TRANSACTION_DETECTED'
      );
    }

    return true;
  }
}

// Instância singleton do serviço de integridade contábil
const ledgerIntegrityService = new LedgerIntegrityService();

module.exports = ledgerIntegrityService;