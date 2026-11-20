/**
 * Classe base de erro operacional da plataforma OneKixikila.
 * Todos os erros de domínio, autorização, validação e negócio estendem esta classe.
 */
class ApplicationError extends Error {
  /**
   * @param {string} message - Mensagem descritiva do erro
   * @param {number} [statusCode=500] - Código de status HTTP associado
   * @param {string} [code='INTERNAL_APPLICATION_ERROR'] - Código de erro padronizado para a API
   * @param {any} [details=null] - Detalhes adicionais higienizados
   */
  constructor(
    message = 'Ocorreu um erro operacional na plataforma.',
    statusCode = 500,
    code = 'INTERNAL_APPLICATION_ERROR',
    details = null
  ) {
    super(message);

    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.status = statusCode; // Compatibilidade com middlewares do Express
    this.code = code;
    this.details = details;
    this.isOperational = true; // Diferencia erros operacionais previstos de falhas não tratadas do runtime

    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Serializa o erro para uma estrutura JSON segura para ser enviada na resposta da API.
   * @returns {object}
   */
  toJSON() {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {})
      }
    };
  }
}

module.exports = ApplicationError;