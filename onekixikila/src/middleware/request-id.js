const crypto = require('crypto');

// Padrão seguro para validação de formato de identificador de rastreamento (alfanumérico e hifens, até 64 caracteres)
const REQUEST_ID_REGEX = /^[a-zA-Z0-9\-_]{8,64}$/;

/**
 * Middleware para geração e propagação de identificador único de requisição (X-Request-ID).
 * Permite correlação de logs de ponta a ponta, rastreamento de operações financeiras e depuração distribuída.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const requestIdMiddleware = (req, res, next) => {
  const incomingHeader = req.headers['x-request-id'];
  let requestId;

  // Reutiliza o identificador recebido se fornecido pelo proxy upstream (Render/Load Balancer) e higienizado
  if (typeof incomingHeader === 'string' && REQUEST_ID_REGEX.test(incomingHeader.trim())) {
    requestId = incomingHeader.trim();
  } else {
    requestId = crypto.randomUUID();
  }

  // Injeta o ID nos objetos da requisição para acesso por controladores, repositórios e logger
  req.id = requestId;
  req.requestId = requestId;

  // Garante envio do cabeçalho na resposta ao cliente
  res.setHeader('X-Request-ID', requestId);

  return next();
};

module.exports = requestIdMiddleware;