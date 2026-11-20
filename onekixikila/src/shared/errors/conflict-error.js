const ApplicationError = require('./application-error');

/**
 * Erro lançado quando uma operação entra em conflito com o estado atual de um recurso,
 * viola restrições de unicidade ou tenta transições de estado incompatíveis (HTTP 409 Conflict).
 */
class ConflictError extends ApplicationError {
  /**
   * @param {string} [message='A operação solicitada entrou em conflito com o estado atual do recurso.']
   * @param {string} [code='RESOURCE_CONFLICT']
   * @param {any} [details=null]
   */
  constructor(
    message = 'A operação solicitada entrou em conflito com o estado atual do recurso.',
    code = 'RESOURCE_CONFLICT',
    details = null
  ) {
    super(message, 409, code, details);
  }

  /**
   * Cria um erro para colisões de campos únicos (email, telefone, BI, slug de grupo).
   * @param {string} resourceName
   * @param {string} fieldName
   * @param {string} [value]
   */
  static duplicate(resourceName, fieldName, value = null) {
    return new ConflictError(
      `Já existe um registo de ${resourceName} com o campo [${fieldName}] informado.`,
      'DUPLICATE_RESOURCE',
      { resource: resourceName, field: fieldName, ...(value ? { value } : {}) }
    );
  }

  /**
   * Cria um erro para transições de estado inválidas no ciclo de vida da Kixikila.
   * @param {string} resourceName
   * @param {string} currentStatus
   * @param {string} attemptedAction
   */
  static invalidStateTransition(resourceName, currentStatus, attemptedAction) {
    return new ConflictError(
      `Não é possível executar [${attemptedAction}] em ${resourceName} no estado atual [${currentStatus}].`,
      'INVALID_STATE_TRANSITION',
      { resource: resourceName, currentStatus, attemptedAction }
    );
  }

  /**
   * Cria um erro para conflitos de concorrência ou operações simultâneas bloqueadas.
   * @param {string} [message='Conflito de concorrência. O recurso foi modificado simultaneamente por outro processo.']
   */
  static concurrency(message = 'Conflito de concorrência. O recurso foi modificado simultaneamente por outro processo.') {
    return new ConflictError(message, 'CONCURRENCY_CONFLICT');
  }

  /**
   * Cria um erro quando uma filiação ou vinculação prévia já existe.
   * @param {string} resourceName
   * @param {string} identifier
   */
  static alreadyExists(resourceName, identifier) {
    return new ConflictError(
      `${resourceName} [${identifier}] já se encontra registado ou associado no sistema.`,
      'ALREADY_EXISTS',
      { resource: resourceName, identifier }
    );
  }
}

module.exports = ConflictError;