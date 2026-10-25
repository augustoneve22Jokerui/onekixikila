const { USER_ROLES } = require('../../shared/constants/roles');
const { USER_STATUSES } = require('../../shared/constants/statuses');

// Níveis canónicos de risco alinhados à migração 014 (risk_level)
const RISK_LEVELS = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL'
});

// Ações mitigatórias padronizadas aplicadas pelo motor de risco
const RISK_ACTIONS = Object.freeze({
  NONE: 'NONE',
  CHALLENGE_REQUIRED: 'CHALLENGE_REQUIRED',
  TEMPORARY_HOLD: 'TEMPORARY_HOLD',
  ACCOUNT_FROZEN: 'ACCOUNT_FROZEN'
});

// Papéis administrativos com permissão formal para auditar e deliberar sobre eventos de risco
const RISK_AUDIT_ROLES = new Set([
  USER_ROLES.ADMIN,
  USER_ROLES.AUDITOR
]);

// Limiares de pontuação (Score) de risco para acionamento de medidas de contenção
const RISK_SCORE_THRESHOLDS = Object.freeze({
  MEDIUM_THRESHOLD: 40,
  HIGH_THRESHOLD: 70,
  CRITICAL_THRESHOLD: 90
});

/**
 * Políticas de autorização, classificação de risco comportamental e determinação
 * de medidas mitigatórias preventivas na plataforma OneKixikila.
 */
class RiskPolicy {
  /**
   * Avalia se o utilizador atuante detém permissão para visualizar eventos de risco e relatórios analíticos.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @returns {boolean}
   */
  canViewRiskEvents(actingUser) {
    if (!actingUser || actingUser.status === USER_STATUSES.BLOCKED || actingUser.status === USER_STATUSES.DEACTIVATED) {
      return false;
    }
    return RISK_AUDIT_ROLES.has(actingUser.role);
  }

  /**
   * Avalia se o utilizador atuante possui privilégios para revisar, mitigar ou desconsiderar um alerta de risco.
   *
   * @param {object} actingUser
   * @param {object} riskEvent - Registro da tabela risk_events
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canReviewRiskEvent(actingUser, riskEvent) {
    if (!actingUser || !RISK_AUDIT_ROLES.has(actingUser.role)) {
      return {
        allowed: false,
        reason: 'A análise e resolução de eventos de risco exige privilégios de AUDITOR ou ADMIN.'
      };
    }

    if (!riskEvent) {
      return { allowed: false, reason: 'Evento de risco não localizado.' };
    }

    // Previne conflito de interesses: o auditor não pode auditar alertas gerados contra a sua própria conta
    if (riskEvent.user_id && actingUser.id === riskEvent.user_id) {
      return {
        allowed: false,
        reason: 'Conflito de interesses: Um auditor não pode deliberar sobre eventos de risco vinculados à sua própria conta.'
      };
    }

    return { allowed: true };
  }

  /**
   * Determina o nível de risco e a ação mitigatória preventiva correspondente com base numa pontuação de anomalia (0 a 100).
   *
   * @param {number} riskScore - Pontuação de risco calculada
   * @returns {{ riskLevel: string, actionTaken: string }}
   */
  evaluateRiskScore(riskScore) {
    const score = Number(riskScore) || 0;

    if (score >= RISK_SCORE_THRESHOLDS.CRITICAL_THRESHOLD) {
      return {
        riskLevel: RISK_LEVELS.CRITICAL,
        actionTaken: RISK_ACTIONS.ACCOUNT_FROZEN
      };
    }

    if (score >= RISK_SCORE_THRESHOLDS.HIGH_THRESHOLD) {
      return {
        riskLevel: RISK_LEVELS.HIGH,
        actionTaken: RISK_ACTIONS.TEMPORARY_HOLD
      };
    }

    if (score >= RISK_SCORE_THRESHOLDS.MEDIUM_THRESHOLD) {
      return {
        riskLevel: RISK_LEVELS.MEDIUM,
        actionTaken: RISK_ACTIONS.CHALLENGE_REQUIRED
      };
    }

    return {
      riskLevel: RISK_LEVELS.LOW,
      actionTaken: RISK_ACTIONS.NONE
    };
  }

  /**
   * Avalia a criticidade de eventos de autenticação anómala (força bruta, rotação rápida de IPs).
   *
   * @param {number} failedAttemptsCount - Tentativas consecutivas de login falhadas
   * @param {boolean} isUnknownDevice - Se o acesso partiu de um dispositivo inédito
   * @param {boolean} isMultipleIps - Se múltiplos IPs distintos foram detectados numa janela curta
   * @returns {{ riskLevel: string, actionTaken: string, score: number }}
   */
  evaluateAuthenticationRisk(failedAttemptsCount = 0, isUnknownDevice = false, isMultipleIps = false) {
    let score = 0;

    score += Math.min(Number(failedAttemptsCount) * 15, 60);

    if (isUnknownDevice) {
      score += 20;
    }

    if (isMultipleIps) {
      score += 25;
    }

    const assessment = this.evaluateRiskScore(score);

    return {
      score,
      riskLevel: assessment.riskLevel,
      actionTaken: assessment.actionTaken
    };
  }

  /**
   * Avalia a criticidade de movimentações financeiras atípicas em Kwanzas (AOA).
   *
   * @param {number|bigint} transactionAmount - Montante da transação pretendida
   * @param {number|bigint} averageUserAmount - Média histórica de movimentação do utilizador
   * @param {boolean} isRapidSuccession - Se operações financeiras sequenciais em rajada foram detectadas
   * @returns {{ riskLevel: string, actionTaken: string, score: number }}
   */
  evaluateTransactionRisk(transactionAmount, averageUserAmount, isRapidSuccession = false) {
    let score = 0;
    const amount = BigInt(transactionAmount || 0);
    const avg = BigInt(averageUserAmount || 0);

    // Se o montante for superior a 5x a média habitual e maior que 500.000 Kz
    if (avg > 0n && amount > avg * 5n && amount > 500000n) {
      score += 45;
    } else if (avg > 0n && amount > avg * 3n) {
      score += 25;
    }

    // Rajada de transferências ou saídas em poucos segundos
    if (isRapidSuccession) {
      score += 35;
    }

    // Montante nominal expressivo (> 2.500.000 Kz)
    if (amount >= 2500000n) {
      score += 20;
    }

    const assessment = this.evaluateRiskScore(score);

    return {
      score,
      riskLevel: assessment.riskLevel,
      actionTaken: assessment.actionTaken
    };
  }

  /**
   * Valida se uma ação mitigatória manual proposta por um auditor é aceitável.
   *
   * @param {string} action
   * @returns {boolean}
   */
  isValidRiskAction(action) {
    return typeof action === 'string' && Object.values(RISK_ACTIONS).includes(action);
  }
}

// Instância singleton da política de risco
const riskPolicy = new RiskPolicy();

module.exports = {
  RISK_LEVELS,
  RISK_ACTIONS,
  RISK_SCORE_THRESHOLDS,
  riskPolicy,
  RiskPolicy
};