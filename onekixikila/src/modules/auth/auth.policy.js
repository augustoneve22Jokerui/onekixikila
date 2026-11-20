const { USER_STATUSES } = require('../../shared/constants/statuses');
const { USER_ROLES } = require('../../shared/constants/roles');

// Constantes de controlo de tentativas falhadas de autenticação e bloqueio temporário
const MAX_FAILED_ATTEMPTS_BEFORE_LOCK = 5;
const LOCKOUT_DURATION_MINUTES = 15;
const MAX_OTP_VERIFICATION_ATTEMPTS = 5;

/**
 * Políticas de autorização, integridade de credenciais e proteção contra força bruta
 * para o ciclo de vida de autenticação na plataforma OneKixikila.
 */
class AuthPolicy {
  /**
   * Avalia se a conta de utilizador está apta a tentar autenticação.
   * Verifica se a conta não está bloqueada administrativamente nem sob bloqueio temporal de força bruta.
   *
   * @param {object} user - Registo do utilizador obtido da base de dados
   * @returns {{ allowed: boolean, reason?: string, statusCode?: number }}
   */
  canAttemptLogin(user) {
    if (!user) {
      return { allowed: false, reason: 'Credenciais de acesso inválidas.', statusCode: 401 };
    }

    if (user.status === USER_STATUSES.BLOCKED) {
      return {
        allowed: false,
        reason: 'Esta conta encontra-se bloqueada por violação das políticas de segurança.',
        statusCode: 403
      };
    }

    if (user.status === USER_STATUSES.DEACTIVATED) {
      return {
        allowed: false,
        reason: 'Esta conta foi desativada. Contacte o apoio da OneKixikila.',
        statusCode: 403
      };
    }

    if (this.isAccountLocked(user)) {
      const remainingSeconds = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000);
      return {
        allowed: false,
        reason: `Conta temporariamente bloqueada por excesso de tentativas. Tente novamente em ${remainingSeconds} segundos.`,
        statusCode: 423
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se determinado utilizador está atualmente sob bloqueio temporário por tentativas falhadas.
   *
   * @param {object} user
   * @returns {boolean}
   */
  isAccountLocked(user) {
    if (!user || !user.locked_until) {
      return false;
    }
    return new Date(user.locked_until).getTime() > Date.now();
  }

  /**
   * Calcula o timestamp futuro de bloqueio temporal caso as tentativas atinjam o teto.
   *
   * @param {number} currentAttempts - Número atual de tentativas falhadas
   * @returns {{ shouldLock: boolean, lockedUntil: Date|null, nextAttempts: number }}
   */
  evaluateFailedLoginAttempt(currentAttempts = 0) {
    const nextAttempts = (currentAttempts || 0) + 1;

    if (nextAttempts >= MAX_FAILED_ATTEMPTS_BEFORE_LOCK) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000);
      return {
        shouldLock: true,
        lockedUntil,
        nextAttempts
      };
    }

    return {
      shouldLock: false,
      lockedUntil: null,
      nextAttempts
    };
  }

  /**
   * Avalia se um código OTP submetido é válido e está dentro do prazo de validade.
   *
   * @param {object} contactRecord - Registo da tabela user_contacts
   * @returns {{ valid: boolean, reason?: string }}
   */
  canVerifyOtp(contactRecord) {
    if (!contactRecord) {
      return { valid: false, reason: 'Nenhum código de validação foi emitido para este contacto.' };
    }

    if (contactRecord.is_verified) {
      return { valid: false, reason: 'Este contacto já se encontra devidamente verificado.' };
    }

    if (!contactRecord.verification_code_hash || !contactRecord.verification_code_expires_at) {
      return { valid: false, reason: 'Código de validação expirado ou inexistente. Solicite um novo código.' };
    }

    const expiresAt = new Date(contactRecord.verification_code_expires_at).getTime();
    if (expiresAt < Date.now()) {
      return { valid: false, reason: 'O código de validação expirou. Solicite um novo envio.' };
    }

    return { valid: true };
  }

  /**
   * Avalia se um utilizador pode alterar a sua própria palavra-passe.
   *
   * @param {object} user - Utilizador autenticado
   * @returns {boolean}
   */
  canChangePassword(user) {
    if (!user || user.status === USER_STATUSES.BLOCKED || user.status === USER_STATUSES.DEACTIVATED) {
      return false;
    }
    return true;
  }

  /**
   * Avalia se o utilizador autenticado possui permissão para revogar determinada sessão (Anti-BOLA/IDOR).
   * O próprio titular pode revogar as suas sessões; administradores possuem permissão de revogação global.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} targetSession - Registo da sessão a revogar
   * @returns {boolean}
   */
  canRevokeSession(actingUser, targetSession) {
    if (!actingUser || !targetSession) {
      return false;
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return true;
    }

    return actingUser.id === targetSession.user_id;
  }
}

// Instância singleton da política de autenticação
const authPolicy = new AuthPolicy();

module.exports = authPolicy;