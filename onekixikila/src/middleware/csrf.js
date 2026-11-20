const crypto = require('crypto');
const securityConfig = require('../config/security');
const appConfig = require('../config/app');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Regex estrita para HMAC SHA-256 em hexadecimal (64 caracteres)
const HEX_HMAC_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * Resolve o segredo dedicado para assinatura de tokens CSRF.
 *
 * ⚠️ SEGURANÇA: o segredo CSRF deve ser DIFERENTE do segredo JWT
 * (separação de segredos criptográficos). Se `securityConfig.csrf.secret`
 * não estiver definido, usamos o JWT secret APENAS em desenvolvimento;
 * em produção, falhamos cedo para forçar configuração correta.
 *
 * @returns {string}
 */
const resolveCsrfSecret = () => {
  const dedicated = securityConfig.csrf && securityConfig.csrf.secret;
  if (typeof dedicated === 'string' && dedicated.trim().length >= 32) {
    return dedicated;
  }

  const isProd =
    typeof appConfig.isProduction === 'boolean'
      ? appConfig.isProduction
      : process.env.NODE_ENV === 'production';

  if (isProd) {
    throw new Error(
      '[CSRF] securityConfig.csrf.secret não está definido (ou tem menos de 32 caracteres). ' +
        'Defina um segredo dedicado para CSRF em produção — NÃO reutilize o segredo JWT.'
    );
  }

  // Fallback de desenvolvimento apenas
  if (!securityConfig.jwt || !securityConfig.jwt.accessTokenSecret) {
    throw new Error(
      '[CSRF] Nem securityConfig.csrf.secret nem securityConfig.jwt.accessTokenSecret estão definidos.'
    );
  }
  return securityConfig.jwt.accessTokenSecret;
};

/**
 * Gera um token CSRF criptograficamente seguro e assinado.
 * @param {string} secret
 * @returns {string} Token em formato salt.hmac
 */
const generateSignedToken = (secret) => {
  const salt = crypto.randomBytes(32).toString('hex'); // 256 bits de entropia
  const hmac = crypto.createHmac('sha256', secret).update(salt).digest('hex');
  return `${salt}.${hmac}`;
};

/**
 * Valida a integridade e assinatura do token CSRF.
 * @param {string} token
 * @param {string} secret
 * @returns {boolean}
 */
const verifySignedToken = (token, secret) => {
  if (typeof token !== 'string' || token.length === 0) {
    return false;
  }

  const separatorIndex = token.indexOf('.');
  if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
    return false;
  }

  const salt = token.slice(0, separatorIndex);
  const providedHmac = token.slice(separatorIndex + 1);

  // Validação estrita do formato: salt hex (>= 32 chars) + HMAC hex (64 chars)
  if (salt.length < 32 || !/^[0-9a-f]+$/i.test(salt)) {
    return false;
  }
  if (!HEX_HMAC_PATTERN.test(providedHmac)) {
    return false;
  }

  const expectedHmac = crypto.createHmac('sha256', secret).update(salt).digest('hex');

  const providedBuffer = Buffer.from(providedHmac, 'hex');
  const expectedBuffer = Buffer.from(expectedHmac, 'hex');

  // Redundante com a regex acima, mas defesa em profundidade
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
};

/**
 * Extrai o token CSRF dos cabeçalhos ou do corpo da requisição.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
const extractSubmittedToken = (req) => {
  const candidates = [
    securityConfig.csrf && securityConfig.csrf.headerName
      ? req.headers[securityConfig.csrf.headerName]
      : null,
    req.headers['x-csrf-token'],
    req.headers['csrf-token'],
    req.body && typeof req.body._csrf === 'string' ? req.body._csrf : null
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
};

/**
 * Verifica se o pedido é uma chamada de API pura (não web).
 * Pedidos de API com Bearer token válido (ou que serão validados pelo
 * `authenticate` a seguir) estão isentos de CSRF — porque não usam cookies.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
const isBearerApiRequest = (req) => {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  // Só isenta se for explicitamente uma rota de API, nunca uma rota web.
  return req.originalUrl.startsWith('/api/');
};

/**
 * Middleware de proteção contra Cross-Site Request Forgery (CSRF).
 * Aplica-se a requisições baseadas em cookies de sessão e formulários web.
 * Isenta rotas puras de API autenticadas via Bearer token e webhooks de prestadores de pagamento.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const csrfProtection = (req, res, next) => {
  const secret = resolveCsrfSecret();
  const cookieName = securityConfig.csrf.cookieName;

  // 1. Isenção: Webhooks de pagamento (protegidos por verificação de assinatura HMAC própria)
  if (req.originalUrl.includes('/webhooks')) {
    return next();
  }

  // 2. Isenção: pedidos de API com Bearer token explícito (rotas /api/*)
  if (isBearerApiRequest(req)) {
    return next();
  }

  // 3. Garante existência do cookie com token assinado válido
  const cookieToken = req.cookies ? req.cookies[cookieName] : null;
  let activeToken = cookieToken;

  if (!activeToken || !verifySignedToken(activeToken, secret)) {
    // Limpa o cookie inválido (se existir) para evitar estado persistente inconsistente
    if (cookieToken) {
      res.clearCookie(cookieName, securityConfig.csrf.cookieOptions);
    }
    activeToken = generateSignedToken(secret);
    res.cookie(cookieName, activeToken, securityConfig.csrf.cookieOptions);
  }

  // Disponibiliza função geradora para templates EJS e respostas
  req.csrfToken = () => activeToken;
  res.locals.csrfToken = activeToken;

  // 4. Métodos seguros de leitura (GET, HEAD, OPTIONS) não sofrem mutação
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  // 5. Validação estrita para métodos com mutação (POST, PUT, PATCH, DELETE)
  const submittedToken = extractSubmittedToken(req);

  const wantsJson = req.originalUrl.startsWith('/api/') || req.xhr || !req.accepts('html');

  if (!submittedToken) {
    if (wantsJson) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'CSRF_TOKEN_MISSING',
          message: 'Token de proteção CSRF obrigatório não fornecido no pedido.'
        }
      });
    }
    return res.status(403).render('errors/403', {
      title: 'Acesso Não Autorizado',
      message: 'Validação de segurança CSRF falhou. Atualize a página e tente novamente.'
    });
  }

  if (!verifySignedToken(submittedToken, secret) || submittedToken !== activeToken) {
    if (wantsJson) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'CSRF_TOKEN_INVALID',
          message: 'Token de proteção CSRF inválido ou expirado.'
        }
      });
    }
    return res.status(403).render('errors/403', {
      title: 'Acesso Não Autorizado',
      message: 'Token de segurança expirado. Por favor, recarregue o formulário.'
    });
  }

  return next();
};

module.exports = csrfProtection;