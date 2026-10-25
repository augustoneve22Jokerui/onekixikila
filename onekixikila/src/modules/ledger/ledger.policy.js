const { USER_ROLES } = require('../../shared/constants/roles');

// Tipos permitidos para contas do livro-razão (alinhados ao ENUM SQL ledger_account_type)
const ALLOWED_ACCOUNT_TYPES = new Set(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']);

// Direções canónicas dos lançamentos contábeis
const ALLOWED_ENTRY_DIRECTIONS = new Set(['DEBIT', 'CREDIT']);

// Papéis com permissão formal para auditar lançamentos e verificar o balanço contábil do sistema
const LEDGER_AUDIT_ROLES = new Set([USER_ROLES.ADMIN, USER_ROLES.AUDITOR, USER_ROLES.FINANCIAL_OPERATOR]);

/**
 * Políticas de autorização, integridade contábil em partidas dobradas
 * e imutabilidade do Livro-Razão (Ledger) da plataforma OneKixikila.
 */
class LedgerPolicy {
  /**
   * Avalia se o utilizador atuante possui permissão para consultar o extrato contábil de determinada conta.
   * O próprio titular pode consultar o extrato da sua conta pessoal;
   * Auditores e Administradores possuem autorização de auditoria contábil ampla.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} ledgerAccount - Registo da conta na tabela ledger_accounts
   * @returns {boolean}
   */
  canViewLedgerAccount(actingUser, ledgerAccount) {
    if (!actingUser || !ledgerAccount) {
      return false;
    }

    if (LEDGER_AUDIT_ROLES.has(actingUser.role)) {
      return true;
    }

    // O utilizador comum só pode consultar a conta vinculada à sua própria carteira
    return Boolean(ledgerAccount.user_id && actingUser.id === ledgerAccount.user_id);
  }

  /**
   * Avalia se o utilizador pode disparar a verificação de integridade e auditoria de balanço do livro-razão.
   *
   * @param {object} actingUser
   * @returns {boolean}
   */
  canAuditLedger(actingUser) {
    if (!actingUser) {
      return false;
    }
    return LEDGER_AUDIT_ROLES.has(actingUser.role);
  }

  /**
   * Valida a equação fundamental das Partidas Dobradas (Double-Entry Bookkeeping).
   * Exige que a soma de todos os débitos seja estritamente igual à soma de todos os créditos,
   * que os montantes sejam estritamente positivos e que haja pelo menos uma perna de débito e uma de crédito.
   *
   * @param {Array<{ accountId: string, direction: 'DEBIT'|'CREDIT', amount: number|bigint }>} entries
   * @returns {{ balanced: boolean, totalDebit: bigint, totalCredit: bigint, reason?: string }}
   */
  validateDoubleEntryBalance(entries) {
    if (!Array.isArray(entries) || entries.length < 2) {
      return {
        balanced: false,
        totalDebit: 0n,
        totalCredit: 0n,
        reason: 'Uma transação contábil exige no mínimo duas entradas em partidas dobradas.'
      };
    }

    let totalDebit = 0n;
    let totalCredit = 0n;
    let hasDebit = false;
    let hasCredit = false;

    for (const entry of entries) {
      if (!entry.accountId) {
        return { balanced: false, totalDebit, totalCredit, reason: 'Identificador de conta ausente na entrada.' };
      }

      if (!ALLOWED_ENTRY_DIRECTIONS.has(entry.direction)) {
        return {
          balanced: false,
          totalDebit,
          totalCredit,
          reason: `Direção de lançamento inválida: [${entry.direction}]. Esperado DEBIT ou CREDIT.`
        };
      }

      const amount = BigInt(entry.amount);
      if (amount <= 0n) {
        return {
          balanced: false,
          totalDebit,
          totalCredit,
          reason: 'O montante de cada perna de lançamento deve ser estritamente superior a zero.'
        };
      }

      if (entry.direction === 'DEBIT') {
        totalDebit += amount;
        hasDebit = true;
      } else {
        totalCredit += amount;
        hasCredit = true;
      }
    }

    if (!hasDebit || !hasCredit) {
      return {
        balanced: false,
        totalDebit,
        totalCredit,
        reason: 'A transação deve possuir pelo menos um débito e pelo menos um crédito.'
      };
    }

    if (totalDebit !== totalCredit) {
      return {
        balanced: false,
        totalDebit,
        totalCredit,
        reason: `Desequilíbrio de partidas dobradas: Total Débito (${totalDebit} AOA) != Total Crédito (${totalCredit} AOA).`
      };
    }

    return { balanced: true, totalDebit, totalCredit };
  }

  /**
   * Avalia a regra de imutabilidade do Livro-Razão.
   * Lançamentos com status 'POSTED' NUNCA podem ser alterados ou apagados.
   * Correções devem ser executadas exclusivamente por transações compensatórias de estorno auditadas.
   *
   * @param {object} existingTransaction
   * @returns {{ immutable: boolean, reason?: string }}
   */
  assertImmutability(existingTransaction) {
    if (!existingTransaction) {
      return { immutable: true };
    }

    if (existingTransaction.status === 'POSTED') {
      return {
        immutable: false,
        reason: 'Violação de integridade contábil: Lançamentos confirmados (POSTED) são imutáveis e não podem sofrer mutação.'
      };
    }

    return { immutable: true };
  }
}

// Instância singleton da política do livro-razão
const ledgerPolicy = new LedgerPolicy();

module.exports = ledgerPolicy;