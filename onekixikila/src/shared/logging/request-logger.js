const logger = require('./logger');
const { redactSensitive } = require('./redaction');

// Rotas ou caminhos de alta frequência e baixo valor diagnóstico que podem ser omitidos do log detalhado
const SILENT_PATHS = new Set(['/favicon.ico', '/robots.txt']);

/**
 * Middleware para rastreamento e registo estruturado de requisições HTTP (Request Logger).
 * Mede a latência de execução de cada rota, correlaciona com o X-Request-ID,
 * captura códigos de estado e reporta falhas com expurgo estrito de dados sensíveis.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const requestLoggerMiddleware = (req, res, next) => {
  // Ignora ficheiros estáticos triviais do navegador
  if (SILENT_PATHS.has(req.path)) {
    return next();
  }

  const startTime = Date.now();
  const requestId = req.id || req.requestId || 'N/A';
  const method = req.method;
  const originalUrl = req.originalUrl || req.url;

  // Resolve o endereço IP real de origem com suporte a proxies reversos (Render)
  const forwardedFor = req.headers['x-forwarded-for'];
  const clientIp =
    (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : null) ||
    req.ip ||
    req.socket.remoteAddress ||
    '127.0.0.1';

  const userAgent = req.headers['user-agent'] || 'UNKNOWN';

  // Regista a conclusão da resposta
  res.on('finish', () => {
    const durationMs = Date.now() - startTime;
    const statusCode = res.statusCode;
    const contentLength = res.getHeader('content-length') || 0;

    // Identificador pseudonimizado do utilizador autenticado
    const userId = req.user && req.user.id ? String(req.user.id) : null;
    const userRole = req.user && req.user.role ? String(req.user.role) : 'ANONYMOUS';

    const logData = {
      module: 'HTTP_REQUEST',
      requestId,
      method,
      url: originalUrl,
      statusCode,
      durationMs,
      contentLength: Number(contentLength),
      clientIp,
      userAgent,
      ...(userId ? { userId, userRole } : {}),
      ...(req.query && Object.keys(req.query).length > 0 ? { query: redactSensitive(req.query) } : {})
    };

    const message = `[HTTP] ${method} ${originalUrl} -> ${statusCode} (${durationMs}ms)`;

    // Classifica a severidade do log de acordo com o resultado HTTP
    if (statusCode >= 500) {
      logger.error(message, null, logData);
    } else if (statusCode >= 400) {
      logger.warn(message, logData);
    } else {
      logger.info(message, logData);
    }
  });

  // Regista caso a ligação seja abortada prematuramente pelo cliente
  res.on('close', () => {
    if (!res.writableEnded) {
      const durationMs = Date.now() - startTime;
      logger.warn(`[HTTP:ABORTED] Conexão terminada pelo cliente antes da resposta: ${method} ${originalUrl}`, {
        module: 'HTTP_REQUEST',
        requestId,
        method,
        url: originalUrl,
        durationMs,
        clientIp
      });
    }
  });

  return next();
};

module.exports = requestLoggerMiddleware;