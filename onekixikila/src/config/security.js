const env = require('./env');
const appConfig = require('./app');

/**
 * Congela recursivamente um objeto e todos os seus subobjetos.
 * O `Object.freeze` nativo é raso (shallow) — este é profundo.
 *
 * ⚠️ Não tenta congelar:
 *   - Buffer / TypedArray / ArrayBuffer (lançam TypeError:
 *     "Cannot freeze array buffer views with elements")
 *   - Date, RegExp, Map, Set (Object.freeze não os congela de verdade)
 *   - Funções (Object.freeze funciona, mas não é o objetivo)
 *
 * @template T
 * @param {T} obj
 * @returns {T}
 */
const deepFreeze = (obj) => {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Arrays buffer views (Buffer, TypedArray) NÃO podem ser congelados.
  // Date / RegExp / Map / Set também não ganham nada em ser congelados.
  if (
    Buffer.isBuffer(obj) ||
    ArrayBuffer.isView(obj) ||
    obj instanceof ArrayBuffer ||
    obj instanceof Date ||
    obj instanceof RegExp ||
    obj instanceof Map ||
    obj instanceof Set
  ) {
    return obj;
  }

  if (Object.isFrozen(obj)) {
    return obj;
  }

  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }

  return Object.freeze(obj);
};

/**
 * Valida e normaliza a chave de encriptação de dados.
 * A chave deve ter PELO MENOS 32 bytes (256 bits) em UTF-8.
 * Se for mais longa, os primeiros 32 bytes são usados (AES-256).
 *
 * @param {string|undefined} rawKey
 * @returns {Buffer}
 */
const resolveEncryptionKey = (rawKey) => {
  if (typeof rawKey !== 'string' || rawKey.length === 0) {
    throw new Error(
      '[SECURITY] DATA_ENCRYPTION_KEY não está definida. Defina uma chave de pelo menos 32 caracteres.'
    );
  }

  const keyBuffer = Buffer.from(rawKey, 'utf-8');
  if (keyBuffer.length < 32) {
    throw new Error(
      `[SECURITY] DATA_ENCRYPTION_KEY tem ${keyBuffer.length} bytes; são necessários pelo menos 32 bytes (256 bits).`
    );
  }

  return keyBuffer.subarray(0, 32);
};

/**
 * Resolve o segredo dedicado para CSRF.
 * Em produção é OBRIGATÓRIO defini-lo (não reutilizar o segredo JWT).
 * Em desenvolvimento, aceita fallback para o segredo JWT com aviso.
 *
 * @returns {string}
 */
const resolveCsrfSecret = () => {
  const dedicated = env.CSRF_SECRET;
  if (typeof dedicated === 'string' && dedicated.trim().length >= 32) {
    return dedicated;
  }

  if (appConfig.isProduction) {
    throw new Error(
      '[SECURITY] CSRF_SECRET não está definido (ou tem menos de 32 caracteres). ' +
        'Defina um segredo dedicado para CSRF em produção — NÃO reutilize JWT_SECRET.'
    );
  }

  // Fallback de desenvolvimento — NUNCA usar em produção
  // eslint-disable-next-line no-console
  console.warn(
    '[SECURITY:WARN] CSRF_SECRET não definido; a usar JWT_SECRET como fallback (apenas desenvolvimento).'
  );
  return env.JWT_SECRET;
};

const securityConfig = deepFreeze({
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
    // resolveEncryptionKey lança erro claro se a chave for inválida
    key: resolveEncryptionKey(env.DATA_ENCRYPTION_KEY),
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
          // ⚠️ TODO SEGURANÇA: 'unsafe-inline' enfraquece o CSP.
          // Migrar scripts inline dos templates EJS para ficheiros externos
          // em /public/js/ ou usar nonces. Remover 'unsafe-inline' após migração.
          "'unsafe-inline'",
          'https://cdn.jsdelivr.net'
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'", // Estilos inline são menos críticos que scripts
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
    // Segredo dedicado — separado do JWT secret (obrigatório em produção)
    secret: resolveCsrfSecret(),
    cookieName: '_csrf_onekixikila',
    headerName: 'x-csrf-token',
    cookieOptions: {
      // ⚠️ O token CSRF NÃO é segredo. Tem de ser legível pelo JavaScript
      // do cliente (apiClient) para ser enviado no header x-csrf-token.
      // A segurança vem da assinatura HMAC, não da confidencialidade.
      httpOnly: false,
      secure: appConfig.isProduction,
      sameSite: appConfig.isProduction ? 'strict' : 'lax',
      path: '/',
      maxAge: 24 * 60 * 60 * 1000 // 24 horas
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
          message:
            'Demasiados pedidos efetuados. Aguarde alguns minutos antes de tentar novamente.'
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
          message:
            'Limite de tentativas de autenticação excedido. Tente novamente mais tarde.'
        }
      }
    }
  }
});

module.exports = securityConfig;