const { USER_ROLES } = require('../../shared/constants/roles');
const { USER_STATUSES, DISPUTE_STATUSES } = require('../../shared/constants/statuses');

// Papéis com permissão formal para conduzir investigações e arbitrar decisões em disputas
const DISPUTE_ARBITRATION_ROLES = new Set([USER_ROLES.ADMIN, USER_ROLES.AUDITOR]);

/**
 * Políticas de autorização, controlo de acesso estrito (Anti-IDOR)
 * e integridade do ciclo de resolução de Disputas e Contestações na plataforma OneKixikila.
 */
class DisputesPolicy {
  /**
   * Avalia se um utilizador detém condições cadastrais para abrir uma contestação formal.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canOpenDispute(actingUser) {
    if (!actingUser) {
      return { allowed: false, reason: 'Autenticação necessária para abrir uma contestação.' };
    }

    if (actingUser.status === USER_STATUSES.BLOCKED || actingUser.status === USER_STATUSES.DEACTIVATED) {
      return {
        allowed: false,
        reason: `A sua conta encontra-se no estado [${actingUser.status}]. Abertura de disputas bloqueada.`
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador atuante possui autorização para consultar a ficha de uma disputa (Anti-IDOR).
   * O requerente inicial (iniciador), a parte reclamada (se especificada) e os árbitros
   * (ADMIN, AUDITOR) possuem permissão legítima de consulta.
   *
   * @param {object} actingUser
   * @param {object} disputeRecord
   * @returns {boolean}
   */
  canViewDispute(actingUser, disputeRecord) {
    if (!actingUser || !disputeRecord) {
      return false;
    }

    if (DISPUTE_ARBITRATION_ROLES.has(actingUser.role)) {
      return true;
    }

    if (actingUser.id === disputeRecord.initiator_user_id) {
      return true;
    }

    if (disputeRecord.respondent_user_id && actingUser.id === disputeRecord.respondent_user_id) {
      return true;
    }

    return false;
  }

  /**
   * Avalia se o utilizador pode emitir parecer técnico, alterar para investigação ou deliberar a resolução da disputa.
   * Ação estritamente reservada a Auditores e Administradores Gerais.
   *
   * @param {object} actingUser
   * @param {object} disputeRecord
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canResolveDispute(actingUser, disputeRecord) {
    if (!actingUser || !DISPUTE_ARBITRATION_ROLES.has(actingUser.role)) {
      return {
        allowed: false,
        reason: 'A mediação e resolução de disputas financeiras exige privilégios de AUDITOR ou ADMIN.'
      };
    }

    if (!disputeRecord) {
      return { allowed: false, reason: 'Registo de disputa não identificado.' };
    }

    // Previne conflito de interesses: o árbitro não pode ser o iniciador nem o reclamado da disputa
    if (actingUser.id === disputeRecord.initiator_user_id || actingUser.id === disputeRecord.respondent_user_id) {
      return {
        allowed: false,
        reason: 'Conflito de interesses: Um utilizador envolvido na disputa não pode arbitrar a sua própria reclamação.'
      };
    }

    if (
      disputeRecord.status === DISPUTE_STATUSES.RESOLVED_FAVOR_INITIATOR ||
      disputeRecord.status === DISPUTE_STATUSES.RESOLVED_FAVOR_RESPONDENT ||
      disputeRecord.status === DISPUTE_STATUSES.CLOSED_DISMISSED
    ) {
      return {
        allowed: false,
        reason: `Esta disputa já foi encerrada com o estado [${disputeRecord.status}] e não pode sofrer nova deliberação.`
      };
    }

    return { allowed: true };
  }

  /**
   * Valida se uma transição de estado no ciclo da disputa é permitida pelas regras da plataforma.
   *
   * @param {string} currentStatus
   * @param {string} newStatus
   * @returns {boolean}
   */
  isValidStatusTransition(currentStatus, newStatus) {
    const validTransitions = {
      OPEN: ['UNDER_INVESTIGATION', 'RESOLVED_FAVOR_INITIATOR', 'RESOLVED_FAVOR_RESPONDENT', 'CLOSED_DISMISSED'],
      UNDER_INVESTIGATION: ['RESOLVED_FAVOR_INITIATOR', 'RESOLVED_FAVOR_RESPONDENT', 'CLOSED_DISMISSED'],
      RESOLVED_FAVOR_INITIATOR: [],
      RESOLVED_FAVOR_RESPONDENT: [],
      CLOSED_DISMISSED: []
    };

    const allowed = validTransitions[currentStatus];
    return Boolean(allowed && allowed.includes(newStatus));
  }
}

// Instância singleton da política de disputas
const disputesPolicy = new DisputesPolicy();

module.exports = disputesPolicy;