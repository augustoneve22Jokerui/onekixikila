const crypto = require('crypto');
const securityConfig = require('../config/security');
const appConfig = require('../config/app');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Gera um token CSRF criptograficamente seguro e assinado.
 * @param {string} secret
 * @returns {string} Token em formato token.assinatura
 */
const generateSignedToken = (secret) => {
  const salt = crypto.randomBytes(16).toString('hex');
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
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return false;
  }

  const [salt, providedHmac] = token.split('.');
  if (!salt || !providedHmac) {
    return false;
  }

  const expectedHmac = crypto.createHmac('sha256', secret).update(salt).digest('hex');

  const providedBuffer = Buffer.from(providedHmac, 'hex');
  const expectedBuffer = Buffer.from(expectedHmac, 'hex');

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
  return (
    req.headers[securityConfig.csrf.headerName] ||
    req.headers['x-csrf-token'] ||
    req.headers['csrf-token'] ||
    (req.body && req.body._csrf) ||
    null
  );
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
  const secret = securityConfig.jwt.accessTokenSecret;
  const cookieName = securityConfig.csrf.cookieName;

  // 1. Isenção: Webhooks de pagamento (protegidos por verificação de assinatura HMAC própria)
  if (req.originalUrl.includes('/webhooks')) {
    return next();
  }

  // 2. Isenção: Pedidos de API com cabeçalho de autenticação Bearer explícito
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ') && !req.cookies[cookieName]) {
    return next();
  }

  // 3. Garante existência do cookie com token assinado
  let existingToken = req.cookies ? req.cookies[cookieName] : null;

  if (!existingToken || !verifySignedToken(existingToken, secret)) {
    existingToken = generateSignedToken(secret);
    res.cookie(cookieName, existingToken, securityConfig.csrf.cookieOptions);
  }

  // Disponibiliza função geradora para templates EJS e respostas
  req.csrfToken = () => existingToken;
  res.locals.csrfToken = existingToken;

  // 4. Métodos seguros de leitura (GET, HEAD, OPTIONS) não sofrem mutação
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  // 5. Validação estrita para métodos com mutação (POST, PUT, PATCH, DELETE)
  const submittedToken = extractSubmittedToken(req);

  if (!submittedToken) {
    if (req.originalUrl.startsWith('/api/') || req.xhr || !req.accepts('html')) {
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

  if (!verifySignedToken(submittedToken, secret) || submittedToken !== existingToken) {
    if (req.originalUrl.startsWith('/api/') || req.xhr || !req.accepts('html')) {
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