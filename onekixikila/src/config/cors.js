const env = require('./env');
const appConfig = require('./app');

// Converte a string de origens separadas por vírgula num array higienizado
const allowedOrigins = env.CORS_ALLOWED_ORIGINS
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const corsConfig = Object.freeze({
  origin: (origin, callback) => {
    // Permite pedidos sem origem (aplicações móveis nativas, curl, ferramentas locais ou same-origin)
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Em ambiente de desenvolvimento permite variações de localhost/127.0.0.1
    if (appConfig.isDevelopment && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }

    const rejectionError = new Error(`Origem [${origin}] não autorizada pelas políticas de CORS.`);
    rejectionError.status = 403;
    return callback(rejectionError, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Request-ID',
    'X-CSRF-Token',
    'Idempotency-Key'
  ],
  exposedHeaders: [
    'X-Request-ID',
    'Content-Disposition',
    'Content-Length'
  ],
  credentials: true,
  maxAge: 86400 // Cache do resultado do preflight por 24 horas
});

module.exports = corsConfig;