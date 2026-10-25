const { USER_ROLES, ADMINISTRATIVE_ROLES } = require('../../shared/constants/roles');
const { USER_STATUSES } = require('../../shared/constants/statuses');

// Teto máximo de sessões ativas simultâneas permitidas por conta de utilizador
const MAX_CONCURRENT_SESSIONS_PER_USER = 10;

/**
 * Políticas de autorização, integridade de sessões e prevenção contra IDOR/BOLA
 * para o módulo de Sessões e Dispositivos da plataforma OneKixikila.
 */
class SessionsPolicy {
  /**
   * Avalia se o utilizador atuante possui autorização para listar as sessões de uma conta.
   * O próprio titular pode consultar as suas sessões; agentes com papel administrativo
   * (ADMIN, AUDITOR, SUPPORT_AGENT) podem consultar para fins de diagnóstico e segurança.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} targetUserId - UUID da conta cujas sessões são requisitadas
   * @returns {boolean}
   */
  canViewSessions(actingUser, targetUserId) {
    if (!actingUser || actingUser.status === USER_STATUSES.BLOCKED || actingUser.status === USER_STATUSES.DEACTIVATED) {
      return false;
    }

    // O próprio titular pode auditar as suas sessões
    if (actingUser.id === targetUserId) {
      return true;
    }

    // Funções administrativas com permissão de supervisão
    return ADMINISTRATIVE_ROLES.includes(actingUser.role);
  }

  /**
   * Avalia se o utilizador atuante possui permissão para revogar determinada sessão (Anti-BOLA/IDOR).
   * O titular pode revogar qualquer sessão da sua própria conta; Administradores podem revogar qualquer sessão.
   *
   * @param {object} actingUser
   * @param {object} targetSession - Registo da sessão obtido da base de dados
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canRevokeSession(actingUser, targetSession) {
    if (!actingUser || !targetSession) {
      return { allowed: false, reason: 'Utilizador ou sessão não identificados.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return { allowed: true };
    }

    if (actingUser.id !== targetSession.user_id) {
      return {
        allowed: false,
        reason: 'Não possui autorização para revogar sessões pertencentes a outro utilizador.'
      };
    }

    if (targetSession.is_revoked) {
      return {
        allowed: false,
        reason: 'Esta sessão já se encontra revogada.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador pode encerrar em massa todas as suas outras sessões ativas.
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @returns {boolean}
   */
  canRevokeOtherSessions(actingUser, targetUserId) {
    if (!actingUser) {
      return false;
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return true;
    }

    return actingUser.id === targetUserId;
  }

  /**
   * Avalia se a sessão ainda está válida operacionalmente (não revogada e não expirada).
   *
   * @param {object} session
   * @returns {boolean}
   */
  isSessionActive(session) {
    if (!session || session.is_revoked) {
      return false;
    }

    const expiresAt = new Date(session.expires_at).getTime();
    return expiresAt > Date.now();
  }

  /**
   * Verifica se o número de sessões ativas ultrapassou o teto permitido de conexões simultâneas.
   *
   * @param {number} activeCount
   * @returns {boolean} True se exceder o limite
   */
  isSessionLimitExceeded(activeCount) {
    return (Number(activeCount) || 0) >= MAX_CONCURRENT_SESSIONS_PER_USER;
  }
}

// Instância singleton da política de sessões
const sessionsPolicy = new SessionsPolicy();

module.exports = sessionsPolicy;