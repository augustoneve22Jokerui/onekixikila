const appConfig = require('../config/app');

/**
 * Mapeamento de códigos de erro nativos do PostgreSQL para códigos e status HTTP amigáveis.
 * @param {string} pgCode
 * @returns {{ status: number, code: string, message: string } | null}
 */
const mapDatabaseError = (pgCode) => {
  switch (pgCode) {
    case '23505': // unique_violation
      return {
        status: 409,
        code: 'RESOURCE_CONFLICT',
        message: 'O registo com estes dados já existe na plataforma.'
      };
    case '23503': // foreign_key_violation
      return {
        status: 400,
        code: 'REFERENTIAL_INTEGRITY_VIOLATION',
        message: 'A operação faz referência a um recurso inexistente ou protegido.'
      };
    case '23514': // check_violation
      return {
        status: 400,
        code: 'DATA_CONSTRAINT_VIOLATION',
        message: 'Os valores fornecidos violam as regras e restrições de integridade do sistema.'
      };
    case '40P01': // deadlock_detected
      return {
        status: 503,
        code: 'TRANSACTION_CONCURRENCY_ERROR',
        message: 'Operação concorrente bloqueada momentaneamente. Tente novamente.'
      };
    default:
      return null;
  }
};

/**
 * Middleware centralizado de tratamento de erros da plataforma OneKixikila.
 * Impede o vazamento de stack traces, consultas SQL, senhas ou segredos para o cliente,
 * fornecendo respostas estruturadas tanto em formato JSON para APIs como em views EJS para a web.
 *
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const errorHandler = (err, req, res, next) => {
  const requestId = req.id || 'N/A';
  let status = err.status || err.statusCode || 500;
  let code = err.code || 'INTERNAL_SERVER_ERROR';
  let message = err.message || 'Ocorreu um erro interno inesperado no servidor.';
  let details = err.details || null;

  // 1. Trata falhas originadas do motor do PostgreSQL (driver pg)
  if (err.code && typeof err.code === 'string' && err.code.length === 5) {
    const dbMapped = mapDatabaseError(err.code);
    if (dbMapped) {
      status = dbMapped.status;
      code = dbMapped.code;
      message = dbMapped.message;
    }
  }

  // 2. Trata falhas de parsing JSON do body-parser nativo do Express
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    status = 400;
    code = 'INVALID_JSON_PAYLOAD';
    message = 'O corpo da requisição contém JSON com sintaxe inválida.';
  }

  // 3. Em produção, protege detalhes internos se for um erro genérico 500
  if (status >= 500 && appConfig.isProduction) {
    message = 'Ocorreu um erro interno no processamento do pedido. A nossa equipa foi notificada.';
    details = null;
  }

  // 4. Registo estruturado de log do erro com o Request-ID
  console.error(`[ERROR:CENTRAL] [${req.method} ${req.originalUrl}] Request-ID: ${requestId} Status: ${status} Code: ${code} - ${err.message}`);
  if (status >= 500 && err.stack && !appConfig.isProduction) {
    console.error(err.stack);
  }

  // 5. Resposta diferenciada para API/AJAX ou navegação tradicional Web (EJS)
  const isApiRequest = req.originalUrl.startsWith('/api/') || req.xhr || !req.accepts('html');

  if (isApiRequest) {
    return res.status(status).json({
      success: false,
      error: {
        code,
        message,
        ...(details ? { details } : {}),
        requestId
      }
    });
  }

  // Resposta para páginas Web renderizadas
  const errorView = status === 404 ? 'errors/404' : status === 403 ? 'errors/403' : 'errors/500';
  return res.status(status).render(errorView, {
    title: `Erro ${status}`,
    message,
    statusCode: status,
    requestId
  });
};

module.exports = errorHandler;