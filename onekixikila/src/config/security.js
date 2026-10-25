const env = require('./env');
const appConfig = require('./app');

const securityConfig = Object.freeze({
  argon2: {
    // Parâmetros Argon2id recomendados para segurança de palavras-passe
    type: 2, // argon2id
    memoryCost: 65536, // 64 MB em KiB
    timeCost: 3, // 3 iterações
    parallelism: 4, // 4 threads paralelas
    hashLength: 32
  },

  jwt: {
    accessTokenSecret: env.JWT_SECRET,
    accessTokenExpiresIn: env.JWT_EXPIRES_IN,
    refreshTokenSecret: env.REFRESH_TOKEN_SECRET,
    refreshTokenExpiresIn: env.REFRESH_TOKEN_EXPIRES_IN,
    algorithm: 'HS256',
    issuer: 'onekixikila-api',
    audience: 'onekixikila-clients'
  },

  encryption: {
    algorithm: 'aes-256-gcm',
    key: Buffer.from(env.DATA_ENCRYPTION_KEY, 'utf-8').subarray(0, 32),
    ivLengthBytes: 16,
    authTagLengthBytes: 16
  },

  helmet: {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'", // Permitido para scripts dinâmicos de inicialização EJS
          'https://cdn.jsdelivr.net' // Bootstrap e SweetAlert2
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://cdn.jsdelivr.net',
          'https://fonts.googleapis.com'
        ],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        mediaSrc: ["'self'", 'blob:', 'data:'],
        connectSrc: [
          "'self'",
          'wss:',
          'ws:',
          env.APP_BASE_URL,
          ...(env.STORAGE_ENDPOINT ? [env.STORAGE_ENDPOINT] : [])
        ],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: appConfig.isProduction ? [] : null
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: appConfig.isProduction
      ? {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: true
        }
      : false
  },

  csrf: {
    cookieName: '_csrf_onekixikila',
    headerName: 'x-csrf-token',
    cookieOptions: {
      httpOnly: true,
      secure: appConfig.isProduction,
      sameSite: appConfig.isProduction ? 'strict' : 'lax',
      path: '/'
    }
  },

  rateLimit: {
    standard: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX_REQUESTS,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Demasiados pedidos efetuados. Aguarde alguns minutos antes de tentar novamente.'
        }
      }
    },
    auth: {
      windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
      max: env.AUTH_RATE_LIMIT_MAX_REQUESTS,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        error: {
          code: 'AUTH_RATE_LIMIT_EXCEEDED',
          message: 'Limite de tentativas de autenticação excedido. Tente novamente mais tarde.'
        }
      }
    }
  }
});

module.exports = securityConfig;