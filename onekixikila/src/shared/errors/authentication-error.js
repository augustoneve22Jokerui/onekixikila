const ApplicationError = require('./application-error');

/**
 * Erro lançado quando uma operação exige autenticação válida ou quando as credenciais fornecidas
 * são inválidas, expiradas ou inexistentes (HTTP 401 Unauthorized).
 */
class AuthenticationError extends ApplicationError {
  /**
   * @param {string} [message='Autenticação necessária para aceder a este recurso.']
   * @param {string} [code='AUTHENTICATION_REQUIRED']
   * @param {any} [details=null]
   */
  constructor(
    message = 'Autenticação necessária para aceder a este recurso.',
    code = 'AUTHENTICATION_REQUIRED',
    details = null
  ) {
    super(message, 401, code, details);
  }

  /**
   * Cria um erro específico para credenciais de acesso inválidas.
   * Mensagem intencionalmente genérica para evitar enumeração de contas.
   */
  static invalidCredentials(message = 'Credenciais de acesso inválidas. Verifique os dados e tente novamente.') {
    return new AuthenticationError(message, 'INVALID_CREDENTIALS');
  }

  /**
   * Cria um erro para tokens JWT com prazo de validade expirado.
   */
  static tokenExpired(message = 'A sua sessão expirou. Inicie sessão novamente.') {
    return new AuthenticationError(message, 'TOKEN_EXPIRED');
  }

  /**
   * Cria um erro para tokens corrompidos, adulterados ou mal formados.
   */
  static invalidToken(message = 'Token de autenticação inválido ou corrompido.') {
    return new AuthenticationError(message, 'INVALID_TOKEN');
  }

  /**
   * Cria um erro para sessões revogadas por logout, rotação ou intervenção administrativa.
   */
  static sessionRevoked(message = 'A sessão ativa foi revogada. Efetue novo login.') {
    return new AuthenticationError(message, 'SESSION_REVOKED');
  }

  /**
   * Cria um erro para tentativas de login em contas temporariamente bloqueadas por força bruta.
   */
  static accountLocked(message = 'Conta temporariamente bloqueada por excesso de tentativas falhadas.') {
    return new AuthenticationError(message, 'ACCOUNT_TEMPORARILY_LOCKED');
  }
}

module.exports = AuthenticationError;