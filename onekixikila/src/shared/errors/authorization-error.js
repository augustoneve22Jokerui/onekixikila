const ApplicationError = require('./application-error');

/**
 * Erro lançado quando o utilizador autenticado não possui privilégios, papéis ou vínculo
 * de filiação suficiente para aceder ou modificar determinado recurso (HTTP 403 Forbidden).
 */
class AuthorizationError extends ApplicationError {
  /**
   * @param {string} [message='Acesso negado. Não possui permissão para executar esta ação.']
   * @param {string} [code='FORBIDDEN_ACCESS']
   * @param {any} [details=null]
   */
  constructor(
    message = 'Acesso negado. Não possui permissão para executar esta ação.',
    code = 'FORBIDDEN_ACCESS',
    details = null
  ) {
    super(message, 403, code, details);
  }

  /**
   * Cria um erro específico para papéis globais insuficientes (RBAC).
   */
  static insufficientPermissions(role = 'USER', required = []) {
    return new AuthorizationError(
      `O seu papel [${role}] não detém as permissões necessárias para este recurso.`,
      'INSUFFICIENT_PERMISSIONS',
      { currentRole: role, requiredRoles: required }
    );
  }

  /**
   * Cria um erro para tentativas de acesso a recursos pertencentes a terceiros (Anti-IDOR).
   */
  static forbiddenResource(message = 'Não possui autorização para aceder ou alterar recursos de outro utilizador.') {
    return new AuthorizationError(message, 'FORBIDDEN_RESOURCE_ACCESS');
  }

  /**
   * Cria um erro quando o utilizador tenta interagir com um grupo de Kixikila sem ser membro ativo.
   */
  static notGroupMember(message = 'Esta operação exige filiação ativa no grupo de Kixikila.') {
    return new AuthorizationError(message, 'NOT_A_GROUP_MEMBER');
  }

  /**
   * Cria um erro para ações restritas à liderança formal do grupo.
   */
  static leadershipRequired(message = 'Ação reservada exclusivamente ao Líder ou Vice-Líder do grupo.') {
    return new AuthorizationError(message, 'LEADERSHIP_ROLE_REQUIRED');
  }

  /**
   * Cria um erro quando a conta está sob sanção, suspensão ou bloqueio.
   */
  static accountRestricted(status = 'SUSPENDED') {
    return new AuthorizationError(
      `A sua conta encontra-se no estado [${status}]. Operação não permitida.`,
      'ACCOUNT_STATUS_RESTRICTED',
      { status }
    );
  }
}

module.exports = AuthorizationError;