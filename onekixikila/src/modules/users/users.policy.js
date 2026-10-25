const { USER_ROLES, ADMINISTRATIVE_ROLES } = require('../../shared/constants/roles');
const { USER_STATUSES } = require('../../shared/constants/statuses');

/**
 * Políticas de autorização, controlo de acesso baseado em função (RBAC),
 * prevenção contra IDOR e integridade cadastral para o módulo de Utilizadores e Perfis.
 */
class UsersPolicy {
  /**
   * Avalia se o utilizador atuante possui autorização para consultar a ficha detalhada de um perfil.
   * O próprio titular pode consultar os seus dados completos; agentes administrativos (ADMIN, SUPPORT_AGENT, AUDITOR)
   * podem aceder para fins de atendimento ou auditoria de conformidade.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} targetUserId - UUID do perfil solicitado
   * @returns {boolean}
   */
  canViewProfile(actingUser, targetUserId) {
    if (!actingUser || actingUser.status === USER_STATUSES.BLOCKED || actingUser.status === USER_STATUSES.DEACTIVATED) {
      return false;
    }

    // O próprio titular pode consultar o seu perfil completo
    if (actingUser.id === targetUserId) {
      return true;
    }

    // Agentes administrativos autorizados
    return ADMINISTRATIVE_ROLES.includes(actingUser.role);
  }

  /**
   * Avalia se o utilizador pode atualizar os dados do perfil (Anti-IDOR).
   * Apenas o próprio titular com conta ativa ou pendente de verificação pode editar os seus dados.
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canUpdateProfile(actingUser, targetUserId) {
    if (!actingUser) {
      return { allowed: false, reason: 'Autenticação necessária.' };
    }

    if (actingUser.id !== targetUserId) {
      return {
        allowed: false,
        reason: 'Não possui autorização para alterar o perfil cadastral de outro utilizador.'
      };
    }

    if (actingUser.status === USER_STATUSES.BLOCKED || actingUser.status === USER_STATUSES.SUSPENDED) {
      return {
        allowed: false,
        reason: `A sua conta encontra-se no estado [${actingUser.status}]. Alterações de perfil não permitidas.`
      };
    }

    if (actingUser.status === USER_STATUSES.DEACTIVATED) {
      return {
        allowed: false,
        reason: 'Esta conta encontra-se desativada.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador pode atualizar e consentir a partilha de localização geográfica.
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @returns {boolean}
   */
  canUpdateLocation(actingUser, targetUserId) {
    return this.canUpdateProfile(actingUser, targetUserId).allowed;
  }

  /**
   * Avalia se o utilizador pode atualizar as preferências de notificação e idioma.
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @returns {boolean}
   */
  canUpdatePreferences(actingUser, targetUserId) {
    return this.canUpdateProfile(actingUser, targetUserId).allowed;
  }

  /**
   * Avalia se o utilizador atuante detém permissão para alterar a função (Role) de um utilizador.
   * Ação estritamente reservada a Administradores (ADMIN), com proibição de auto-despromoção acidental.
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @param {string} newRole
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canChangeUserRole(actingUser, targetUserId, newRole) {
    if (!actingUser || actingUser.role !== USER_ROLES.ADMIN) {
      return {
        allowed: false,
        reason: 'A alteração de papéis globais exige privilégios de Administrador Geral (ADMIN).'
      };
    }

    // Previne que o administrador remova acidentalmente a sua própria função de ADMIN
    if (actingUser.id === targetUserId && newRole !== USER_ROLES.ADMIN) {
      return {
        allowed: false,
        reason: 'Um administrador não pode revogar a sua própria função de ADMIN para evitar bloqueio do sistema.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador atuante pode alterar o estado operacional de uma conta (bloquear ou suspender).
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @param {string} newStatus
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canChangeUserStatus(actingUser, targetUserId, newStatus) {
    if (!actingUser || actingUser.role !== USER_ROLES.ADMIN) {
      return {
        allowed: false,
        reason: 'A gestão do estado de contas é restrita a Administradores.'
      };
    }

    // Previne auto-bloqueio administrativo
    if (actingUser.id === targetUserId && (newStatus === USER_STATUSES.BLOCKED || newStatus === USER_STATUSES.SUSPENDED)) {
      return {
        allowed: false,
        reason: 'Não é permitido aplicar sanções ou bloqueios à sua própria conta de administrador.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se uma conta pode ser desativada ou eliminada logicamente (Soft Delete).
   * Impede a exclusão caso o utilizador possua quotas pendentes ativas em grupos de Kixikila
   * ou fundos remanescentes não levantados na carteira digital.
   *
   * @param {object} actingUser
   * @param {object} targetUser
   * @param {object} [financialContext={}]
   * @param {number} [financialContext.availableBalance=0]
   * @param {number} [financialContext.lockedBalance=0]
   * @param {number} [financialContext.activeObligationsCount=0]
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canDeactivateAccount(actingUser, targetUser, financialContext = {}) {
    if (!actingUser || !targetUser) {
      return { allowed: false, reason: 'Utilizador não identificado.' };
    }

    const isSelf = actingUser.id === targetUser.id;
    const isAdmin = actingUser.role === USER_ROLES.ADMIN;

    if (!isSelf && !isAdmin) {
      return {
        allowed: false,
        reason: 'Apenas o titular ou um administrador podem solicitar a desativação da conta.'
      };
    }

    const {
      availableBalance = 0,
      lockedBalance = 0,
      activeObligationsCount = 0
    } = financialContext;

    if (activeObligationsCount > 0) {
      return {
        allowed: false,
        reason: 'Não é possível desativar a conta com quotas de Kixikila ativas ou pendentes de pagamento.'
      };
    }

    if (availableBalance > 0 || lockedBalance > 0) {
      return {
        allowed: false,
        reason: `A carteira possui saldo remanescente (${availableBalance + lockedBalance} Kz). Efetue o levantamento total antes do encerramento.`
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador pode listar e pesquisar contas de terceiros na plataforma.
   *
   * @param {object} actingUser
   * @returns {boolean}
   */
  canListUsers(actingUser) {
    if (!actingUser) {
      return false;
    }
    return ADMINISTRATIVE_ROLES.includes(actingUser.role);
  }
}

// Instância singleton da política de utilizadores
const usersPolicy = new UsersPolicy();

module.exports = usersPolicy;