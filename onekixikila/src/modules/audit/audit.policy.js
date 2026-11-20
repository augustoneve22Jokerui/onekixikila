const { USER_ROLES } = require('../../shared/constants/roles');
const { USER_STATUSES } = require('../../shared/constants/statuses');

// Papéis com autorização formal para consultar o registo institucional de auditoria
const AUDIT_INSPECTION_ROLES = new Set([
  USER_ROLES.ADMIN,
  USER_ROLES.AUDITOR
]);

// Ações canónicas de auditoria previstas no esquema SQL (audit_action enum)
const VALID_AUDIT_ACTIONS = new Set([
  'CREATE',
  'UPDATE',
  'DELETE',
  'LOGIN',
  'LOGOUT',
  'PASSWORD_CHANGE',
  'ROLE_CHANGE',
  'STATUS_CHANGE',
  'KYC_REVIEW',
  'FINANCIAL_TRANSACTION',
  'EXPORT_DATA',
  'ADMIN_ACTION'
]);

// Tipos de recursos monitorizados na plataforma
const VALID_RESOURCE_TYPES = new Set([
  'USER',
  'USER_PROFILE',
  'USER_DEVICE',
  'SESSION',
  'GROUP',
  'GROUP_RULES',
  'GROUP_LOCATION',
  'GROUP_MEMBERSHIP',
  'GROUP_INVITATION',
  'LEADERSHIP_ASSIGNMENT',
  'GROUP_SCHEDULE',
  'CONTRIBUTION_OBLIGATION',
  'CONTRIBUTION',
  'ROTATION_PLAN',
  'ROTATION_PAYOUT',
  'ROTATION_SWAP',
  'WALLET',
  'LEDGER_TRANSACTION',
  'DEPOSIT',
  'WITHDRAWAL',
  'INTERNAL_TRANSFER',
  'PAYMENT_REQUEST',
  'QR_TOKEN',
  'FEE',
  'LIMIT_RULE',
  'DISPUTE',
  'RISK_EVENT',
  'NOTIFICATION',
  'CHAT_MESSAGE',
  'CHAT_REPORT',
  'DOCUMENT',
  'VERIFICATION_DOCUMENT',
  'STORAGE_FILE',
  'STORAGE_OBJECT'
]);

/**
 * Políticas de autorização, integridade de registos e imutabilidade append-only
 * para o módulo de Auditoria Institucional da plataforma OneKixikila.
 */
class AuditPolicy {
  /**
   * Avalia se o utilizador atuante possui privilégios para consultar a esteira de eventos de auditoria.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canViewAuditLogs(actingUser) {
    if (!actingUser) {
      return { allowed: false, reason: 'Autenticação necessária para consultar registos de auditoria.' };
    }

    if (actingUser.status === USER_STATUSES.BLOCKED || actingUser.status === USER_STATUSES.DEACTIVATED) {
      return {
        allowed: false,
        reason: `A sua conta encontra-se no estado [${actingUser.status}]. Consulta não autorizada.`
      };
    }

    if (!AUDIT_INSPECTION_ROLES.has(actingUser.role)) {
      return {
        allowed: false,
        reason: 'Acesso negado: A consulta à esteira de auditoria institucional exige privilégios de AUDITOR ou ADMIN.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se um utilizador comum pode consultar o seu próprio histórico de segurança
   * (ex: logins recentes, alteração de senha e dispositivos vinculados).
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @returns {boolean}
   */
  canViewOwnSecurityHistory(actingUser, targetUserId) {
    if (!actingUser || !targetUserId) {
      return false;
    }

    if (AUDIT_INSPECTION_ROLES.has(actingUser.role)) {
      return true;
    }

    return actingUser.id === targetUserId;
  }

  /**
   * Valida a conformidade dos parâmetros e filtros para consulta de auditoria.
   *
   * @param {object} filters
   * @returns {{ valid: boolean, reason?: string }}
   */
  validateAuditFilters(filters) {
    if (!filters) {
      return { valid: true };
    }

    if (filters.action && !VALID_AUDIT_ACTIONS.has(filters.action.toUpperCase())) {
      return {
        valid: false,
        reason: `Ação de auditoria [${filters.action}] inválida. Ações válidas: ${Array.from(VALID_AUDIT_ACTIONS).join(', ')}.`
      };
    }

    if (filters.resourceType && !VALID_RESOURCE_TYPES.has(filters.resourceType.toUpperCase())) {
      return {
        valid: false,
        reason: `Tipo de recurso de auditoria [${filters.resourceType}] não catalogado.`
      };
    }

    return { valid: true };
  }

  /**
   * Impõe a regra inegociável de imutabilidade estrita: eventos de auditoria são append-only
   * e NUNCA podem ser editados, alterados ou eliminados por qualquer utilizador ou processo.
   *
   * @returns {never} Lança exceção caso invocada uma operação de mutação
   */
  assertImmutability() {
    throw new Error('Violação de conformidade: Registos de auditoria institucional são imutáveis e não comportam mutação ou exclusão.');
  }
}

// Instância singleton da política de auditoria
const auditPolicy = new AuditPolicy();

module.exports = {
  VALID_AUDIT_ACTIONS,
  VALID_RESOURCE_TYPES,
  auditPolicy,
  AuditPolicy
};