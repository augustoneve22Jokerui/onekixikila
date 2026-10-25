const appConfig = require('../config/app');

/**
 * Cria um middleware de tempo limite de processamento para requisições HTTP.
 * Interrompe requisições travadas ou lentas para prevenir esgotamento de conexões e memória.
 *
 * @param {number} [timeoutMs] - Tempo limite em milissegundos (padrão derivado de appConfig)
 * @returns {import('express').RequestHandler}
 */
const requestTimeout = (timeoutMs = appConfig.server.requestTimeoutMs) => {
  return (req, res, next) => {
    // Configura o temporizador da requisição
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        req.timedout = true;

        const requestId = req.id || 'N/A';
        console.warn(`[SERVER:TIMEOUT] Requisição abortada por exceder ${timeoutMs}ms: [${req.method} ${req.originalUrl}] Request-ID: ${requestId}`);

        res.status(504).json({
          success: false,
          error: {
            code: 'REQUEST_TIMEOUT',
            message: 'O servidor demorou demasiado tempo a responder. Tente novamente mais tarde.',
            timeoutMs
          }
        });
      }
    }, timeoutMs);

    // Limpa o temporizador quando a resposta é concluída ou a conexão é fechada pelo cliente
    const cleanup = () => {
      clearTimeout(timer);
    };

    res.on('finish', cleanup);
    res.on('close', cleanup);

    return next();
  };
};

module.exports = requestTimeout;