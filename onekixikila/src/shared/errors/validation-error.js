const ApplicationError = require('./application-error');

/**
 * Erro lançado quando os dados fornecidos na requisição falham na validação de tipos,
 * regras de formato, restrições numéricas ou integridade de esquema (HTTP 400 Bad Request).
 */
class ValidationError extends ApplicationError {
  /**
   * @param {string} [message='Dados de entrada inválidos ou mal formatados.']
   * @param {any} [details=null] - Lista estruturada de campos e mensagens de erro ({ field, message })
   * @param {string} [code='VALIDATION_ERROR']
   */
  constructor(
    message = 'Dados de entrada inválidos ou mal formatados.',
    details = null,
    code = 'VALIDATION_ERROR'
  ) {
    super(message, 400, code, details);
  }

  /**
   * Cria um ValidationError a partir de um array de inconsistências ({ field, message }).
   * @param {Array<{ field: string, message: string }>} issues
   * @param {string} [message]
   */
  static fromIssues(issues, message = 'Inconsistências detetadas nos campos informados.') {
    return new ValidationError(message, issues, 'SCHEMA_VALIDATION_FAILED');
  }

  /**
   * Cria um erro específico para ausência de um campo obrigatório.
   * @param {string} fieldName
   */
  static fieldRequired(fieldName) {
    return new ValidationError(
      `O campo [${fieldName}] é obrigatório.`,
      [{ field: fieldName, message: 'Campo obrigatório não fornecido.' }],
      'REQUIRED_FIELD_MISSING'
    );
  }

  /**
   * Cria um erro para formato inválido em determinado campo.
   * @param {string} fieldName
   * @param {string} expectedFormat
   */
  static invalidFormat(fieldName, expectedFormat) {
    return new ValidationError(
      `O campo [${fieldName}] possui formato inválido. Formato esperado: ${expectedFormat}.`,
      [{ field: fieldName, message: `Formato inválido. Esperado: ${expectedFormat}.` }],
      'INVALID_FIELD_FORMAT'
    );
  }

  /**
   * Cria um erro para violações de limites numéricos ou monetários em Kwanzas.
   * @param {string} fieldName
   * @param {string} reason
   */
  static invalidValue(fieldName, reason) {
    return new ValidationError(
      `Valor inválido para o campo [${fieldName}]: ${reason}`,
      [{ field: fieldName, message: reason }],
      'INVALID_FIELD_VALUE'
    );
  }
}

module.exports = ValidationError;