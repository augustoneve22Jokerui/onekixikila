const ApplicationError = require('./application-error');

/**
 * Erro lançado quando um recurso solicitado não é localizado na base de dados
 * ou não existe na plataforma OneKixikila (HTTP 404 Not Found).
 */
class NotFoundError extends ApplicationError {
  /**
   * @param {string} [message='O recurso solicitado não foi encontrado.']
   * @param {string} [code='RESOURCE_NOT_FOUND']
   * @param {any} [details=null]
   */
  constructor(
    message = 'O recurso solicitado não foi encontrado.',
    code = 'RESOURCE_NOT_FOUND',
    details = null
  ) {
    super(message, 404, code, details);
  }

  /**
   * Cria um erro específico para um recurso com identificador.
   * @param {string} resourceName
   * @param {string} [identifier]
   */
  static resource(resourceName, identifier = null) {
    const idMsg = identifier ? ` com identificador [${identifier}]` : '';
    return new NotFoundError(
      `${resourceName}${idMsg} não foi encontrado no sistema.`,
      `${resourceName.toUpperCase().replace(/\s+/g, '_')}_NOT_FOUND`,
      identifier ? { resource: resourceName, identifier } : null
    );
  }

  /**
   * Cria um erro específico para utilizador não localizado.
   * @param {string} [identifier]
   */
  static user(identifier = null) {
    return NotFoundError.resource('Utilizador', identifier);
  }

  /**
   * Cria um erro específico para grupo de Kixikila não localizado.
   * @param {string} [identifier]
   */
  static group(identifier = null) {
    return NotFoundError.resource('Grupo de Kixikila', identifier);
  }

  /**
   * Cria um erro específico para carteira não localizada.
   * @param {string} [identifier]
   */
  static wallet(identifier = null) {
    return NotFoundError.resource('Carteira', identifier);
  }

  /**
   * Cria um erro específico para ficheiro ou documento não localizado.
   * @param {string} [identifier]
   */
  static document(identifier = null) {
    return NotFoundError.resource('Documento', identifier);
  }
}

module.exports = NotFoundError;