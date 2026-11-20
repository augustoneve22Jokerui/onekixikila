const { DISCREPANCY_TYPES } = require('../contracts/reconciliation.contract');

// Papéis autorizados a aceder e supervisionar relatórios de conciliação financeira
const RECONCILIATION_VIEW_ROLES = new Set(['ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR']);

// Papéis autorizados a disparar conciliações manuais
const RECONCILIATION_TRIGGER_ROLES = new Set(['ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR']);

// Papéis com poder para emitir parecer técnico e resolver discrepâncias financeiras
const DISCREPANCY_RESOLVER_ROLES = new Set(['ADMIN', 'AUDITOR']);

// Limiar em Kwanzas (AOA) a partir do qual uma discrepância é classificada como crítica
const CRITICAL_DISCREPANCY_THRESHOLD_AOA = 10000; // 10.000 Kz

/**
 * Políticas de autorização, integridade e governança para a conciliação bancária.
 */
class ReconciliationPolicy {
  /**
   * Avalia se o utilizador possui autorização para disparar uma conciliação.
   *
   * @param {object} user - Utilizador autenticado (req.user)
   * @returns {boolean}
   */
  canTriggerReconciliation(user) {
    if (!user || user.status !== 'ACTIVE') {
      return false;
    }
    return RECONCILIATION_TRIGGER_ROLES.has(user.role);
  }

  /**
   * Avalia se o utilizador pode consultar o histórico e detalhes de conciliação.
   *
   * @param {object} user
   * @returns {boolean}
   */
  canViewReconciliation(user) {
    if (!user || user.status !== 'ACTIVE') {
      return false;
    }
    return RECONCILIATION_VIEW_ROLES.has(user.role);
  }

  /**
   * Avalia se o utilizador pode resolver manualmente uma discrepância apurada em lote.
   *
   * @param {object} user
   * @param {object} batch - Lote de conciliação retornado pela base de dados
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canResolveDiscrepancy(user, batch) {
    if (!user || user.status !== 'ACTIVE') {
      return { allowed: false, reason: 'Utilizador inativo ou não autenticado.' };
    }

    if (!DISCREPANCY_RESOLVER_ROLES.has(user.role)) {
      return {
        allowed: false,
        reason: 'A resolução de discrepâncias contábeis exige privilégios de AUDITOR ou ADMIN.'
      };
    }

    if (!batch) {
      return { allowed: false, reason: 'Lote de conciliação inexistente.' };
    }

    if (batch.status === 'MATCHED') {
      return { allowed: false, reason: 'O lote não possui discrepâncias em aberto.' };
    }

    if (batch.status === 'MANUALLY_RESOLVED') {
      return { allowed: false, reason: 'Este lote de conciliação já foi resolvido e consolidado.' };
    }

    return { allowed: true };
  }

  /**
   * Avalia a severidade de uma discrepância identificada durante o cruzamento contábil.
   *
   * @param {object} discrepancy
   * @returns {'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'}
   */
  assessDiscrepancySeverity(discrepancy) {
    if (!discrepancy) {
      return 'LOW';
    }

    // Crédito bancário sem registo interno (órfão) é risco crítico de auditoria
    if (discrepancy.type === DISCREPANCY_TYPES.MISSING_IN_INTERNAL) {
      return 'CRITICAL';
    }

    // Divergência de valores superior ao limiar regulatório
    if (discrepancy.type === DISCREPANCY_TYPES.AMOUNT_MISMATCH) {
      const diff = Math.abs((discrepancy.internalAmount || 0) - (discrepancy.externalAmount || 0));
      if (diff >= CRITICAL_DISCREPANCY_THRESHOLD_AOA) {
        return 'CRITICAL';
      }
      return 'HIGH';
    }

    // Transação confirmada no sistema mas ausente na compensação bancária
    if (discrepancy.type === DISCREPANCY_TYPES.MISSING_IN_EXTERNAL) {
      return 'HIGH';
    }

    return 'MEDIUM';
  }
}

// Instância singleton da política de conciliação
const reconciliationPolicy = new ReconciliationPolicy();

module.exports = reconciliationPolicy;