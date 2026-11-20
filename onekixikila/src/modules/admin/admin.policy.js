const { USER_ROLES, ADMINISTRATIVE_ROLES } = require('../../shared/constants/roles');
const { USER_STATUSES, GROUP_STATUSES } = require('../../shared/constants/statuses');

// Papéis com privilégios de acesso ao painel de administração geral
const ADMIN_DASHBOARD_ROLES = new Set([
  USER_ROLES.ADMIN,
  USER_ROLES.AUDITOR,
  USER_ROLES.SUPPORT_AGENT,
  USER_ROLES.FINANCIAL_OPERATOR
]);

// Papéis com autorização para alteração de papéis globais (Role assignment)
const ROLE_MANAGEMENT_ROLES = new Set([
  USER_ROLES.ADMIN
]);

// Papéis com autorização para aplicação de sanções, bloqueios e reativação de contas
const USER_STATUS_MANAGEMENT_ROLES = new Set([
  USER_ROLES.ADMIN,
  USER_ROLES.AUDITOR
]);

// Papéis com autorização para intervenção e supervisão direta de grupos de Kixikila
const GROUP_SUPERVISION_ROLES = new Set([
  USER_ROLES.ADMIN,
  USER_ROLES.AUDITOR
]);

// Papéis com autorização para governança e supervisão financeira (tarifas, conciliação e limites)
const FINANCIAL_ADMIN_ROLES = new Set([
  USER_ROLES.ADMIN,
  USER_ROLES.AUDITOR,
  USER_ROLES.FINANCIAL_OPERATOR
]);

// Papéis autorizados a consultar registos brutos de auditoria institucional
const SYSTEM_AUDIT_ROLES = new Set([
  USER_ROLES.ADMIN,
  USER_ROLES.AUDITOR
]);

/**
 * Políticas de autorização, integridade administrativa e princípio de privilégios mínimos
 * para o módulo de Administração e Governança da plataforma OneKixikila.
 */
class AdminPolicy {
  /**
   * Avalia se o utilizador atuante possui acesso às ferramentas do painel administrativo.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canAccessAdminPanel(actingUser) {
    if (!actingUser) {
      return { allowed: false, reason: 'Autenticação prévia obrigatória para acesso à área administrativa.' };
    }

    if (actingUser.status === USER_STATUSES.BLOCKED || actingUser.status === USER_STATUSES.DEACTIVATED) {
      return {
        allowed: false,
        reason: `A sua conta encontra-se no estado [${actingUser.status}]. Acesso restrito.`
      };
    }

    if (!ADMIN_DASHBOARD_ROLES.has(actingUser.role)) {
      return {
        allowed: false,
        reason: 'Acesso negado: O seu papel não possui privilégios administrativos na plataforma.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o administrador pode alterar a função global (Role) de um utilizador.
   * Impede a auto-despromoção acidental do próprio administrador.
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @param {string} newRole
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canManageUserRole(actingUser, targetUserId, newRole) {
    const accessCheck = this.canAccessAdminPanel(actingUser);
    if (!accessCheck.allowed) {
      return accessCheck;
    }

    if (!ROLE_MANAGEMENT_ROLES.has(actingUser.role)) {
      return {
        allowed: false,
        reason: 'A alteração de papéis globais é reservada exclusivamente a Administradores Gerais (ADMIN).'
      };
    }

    if (actingUser.id === targetUserId && newRole !== USER_ROLES.ADMIN) {
      return {
        allowed: false,
        reason: 'Proteção de governança: Um administrador não pode revogar a sua própria função de ADMIN.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o administrador pode alterar o estado operacional de uma conta (bloquear/suspender/reativar).
   * Impede a auto-aplicação de sanções disciplinares.
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @param {string} newStatus
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canManageUserStatus(actingUser, targetUserId, newStatus) {
    const accessCheck = this.canAccessAdminPanel(actingUser);
    if (!accessCheck.allowed) {
      return accessCheck;
    }

    if (!USER_STATUS_MANAGEMENT_ROLES.has(actingUser.role)) {
      return {
        allowed: false,
        reason: 'A gestão do estado operacional de contas exige privilégios de ADMIN ou AUDITOR.'
      };
    }

    if (actingUser.id === targetUserId && (newStatus === USER_STATUSES.BLOCKED || newStatus === USER_STATUSES.SUSPENDED)) {
      return {
        allowed: false,
        reason: 'Não é permitido aplicar suspensão ou bloqueio à sua própria conta de administrador.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o administrador pode suspender, pausar ou alterar administrativamente um grupo de Kixikila.
   *
   * @param {object} actingUser
   * @param {object} group
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canSuperviseGroup(actingUser, group) {
    const accessCheck = this.canAccessAdminPanel(actingUser);
    if (!accessCheck.allowed) {
      return accessCheck;
    }

    if (!GROUP_SUPERVISION_ROLES.has(actingUser.role)) {
      return {
        allowed: false,
        reason: 'A supervisão e intervenção em grupos exige privilégios de ADMIN ou AUDITOR.'
      };
    }

    if (group && (group.status === GROUP_STATUSES.COMPLETED || group.status === GROUP_STATUSES.CANCELLED)) {
      return {
        allowed: false,
        reason: `Grupos no estado [${group.status}] não comportam intervenções operacionais.`
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o administrador pode gerir operações financeiras, reconciliações ou matriz de tarifas.
   * O suporte ao cliente não pode movimentar valores nem editar tarifas.
   *
   * @param {object} actingUser
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canManageFinancialOperations(actingUser) {
    const accessCheck = this.canAccessAdminPanel(actingUser);
    if (!accessCheck.allowed) {
      return accessCheck;
    }

    if (!FINANCIAL_ADMIN_ROLES.has(actingUser.role)) {
      return {
        allowed: false,
        reason: 'A supervisão financeira e conciliação de pagamentos exige privilégios de FINANCIAL_OPERATOR, AUDITOR ou ADMIN.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador pode consultar os registos de auditoria institucional (`audit_events`).
   *
   * @param {object} actingUser
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canViewAuditLogs(actingUser) {
    const accessCheck = this.canAccessAdminPanel(actingUser);
    if (!accessCheck.allowed) {
      return accessCheck;
    }

    if (!SYSTEM_AUDIT_ROLES.has(actingUser.role)) {
      return {
        allowed: false,
        reason: 'A consulta de registos de auditoria institucional é restrita a AUDITOR e ADMIN.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador pode consultar relatórios agregados de desempenho e conformidade.
   *
   * @param {object} actingUser
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canViewSystemReports(actingUser) {
    return this.canAccessAdminPanel(actingUser);
  }
}

// Instância singleton da política administrativa
const adminPolicy = new AdminPolicy();

module.exports = adminPolicy;