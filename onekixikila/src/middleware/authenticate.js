// =============================================================================
// middleware/authenticate.js
// =============================================================================

const jwt = require('jsonwebtoken');
const securityConfig = require('../config/security');
const { queryOne } = require('../database/query');

// Cache em memória de utilizadores autenticados.
// Cada entrada tem um TTL curto (30s) para reduzir drasticamente o número de
// queries a `users` por pedido — evitando o custo de 2.2s por autenticação
// observado nos logs e mantendo a consistência dos dados.
const USER_CACHE_TTL_MS = 30 * 1000;
const USER_CACHE_MAX_SIZE = 5000;
const userCache = new Map();

/**
 * Obtém o utilizador do cache se a entrada ainda for válida.
 * @param {string} userId
 * @returns {object|null}
 */
const getCachedUser = (userId) => {
  const entry = userCache.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    userCache.delete(userId);
    return null;
  }
  return entry.user;
};

/**
 * Insere ou atualiza o utilizador no cache.
 * @param {string} userId
 * @param {object} user
 */
const setCachedUser = (userId, user) => {
  if (userCache.size >= USER_CACHE_MAX_SIZE) {
    // Elimina a entrada mais antiga (FIFO)
    const oldestKey = userCache.keys().next().value;
    if (oldestKey) userCache.delete(oldestKey);
  }
  userCache.set(userId, {
    user,
    expiresAt: Date.now() + USER_CACHE_TTL_MS
  });
};

/**
 * Remove um utilizador do cache (usado quando o token é inválido ou o estado muda).
 * @param {string} userId
 */
const invalidateCachedUser = (userId) => {
  if (userId) userCache.delete(userId);
};

/**
 * Extrai o token Bearer do cabeçalho Authorization ou do cookie de sessão.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
const extractToken = (req) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }

  if (req.cookies && req.cookies.onekixikila_token) {
    return req.cookies.onekixikila_token;
  }

  return null;
};

/**
 * Verifica o JWT e carrega o utilizador da base de dados (com cache curta).
 * Lança um erro tipado em caso de falha.
 *
 * @param {string} token
 * @returns {Promise<{user: object, auth: object}>}
 */
const loadUserFromToken = async (token) => {
  const decoded = jwt.verify(token, securityConfig.jwt.accessTokenSecret, {
    algorithms: [securityConfig.jwt.algorithm],
    issuer: securityConfig.jwt.issuer,
    audience: securityConfig.jwt.audience
  });

  const cached = getCachedUser(decoded.sub);
  if (cached) {
    const authObject = Object.freeze({
      tokenId: decoded.jti || null,
      sessionId: decoded.sessionId || null,
      issuedAt: decoded.iat,
      expiresAt: decoded.exp
    });
    return { user: cached, auth: authObject };
  }

  const userQuery = `
    SELECT 
      u.id, 
      u.email, 
      u.phone_number, 
      u.role, 
      u.status, 
      u.is_email_verified, 
      u.is_phone_verified,
      u.locked_until,
      p.full_name,
      p.preferred_name,
      p.country,
      p.province,
      p.municipality
    FROM users u
    LEFT JOIN user_profiles p ON p.user_id = u.id
    WHERE u.id = $1 AND u.deleted_at IS NULL;
  `;

  const user = await queryOne(userQuery, [decoded.sub]);

  if (!user) {
    const err = new Error('Utilizador associado ao token não existe ou foi removido.');
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  if (user.status === 'BLOCKED' || user.status === 'SUSPENDED') {
    const err = new Error(
      `A sua conta encontra-se no estado [${user.status}]. Contacte o suporte da OneKixikila.`
    );
    err.code = 'ACCOUNT_RESTRICTED';
    throw err;
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const err = new Error('Conta temporariamente bloqueada por excesso de tentativas falhadas.');
    err.code = 'ACCOUNT_TEMPORARILY_LOCKED';
    throw err;
  }

  const userObject = Object.freeze({
    id: user.id,
    email: user.email,
    phoneNumber: user.phone_number,
    role: user.role,
    status: user.status,
    isEmailVerified: user.is_email_verified,
    isPhoneVerified: user.is_phone_verified,
    fullName: user.full_name,
    preferredName: user.preferred_name || user.full_name,
    location: {
      country: user.country,
      province: user.province,
      municipality: user.municipality
    }
  });

  setCachedUser(user.id, userObject);

  const authObject = Object.freeze({
    tokenId: decoded.jti || null,
    sessionId: decoded.sessionId || null,
    issuedAt: decoded.iat,
    expiresAt: decoded.exp
  });

  return { user: userObject, auth: authObject };
};

/**
 * Middleware central de autenticação da plataforma OneKixikila.
 * Valida o token JWT (Access Token), confirma o estado ativo do utilizador na base de dados
 * e verifica se a sessão correspondente não foi revogada.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const authenticate = async (req, res, next) => {
  try {
    const token = extractToken(req);

    if (!token) {
      if (req.originalUrl.startsWith('/api/') || req.xhr || !req.accepts('html')) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'AUTHENTICATION_REQUIRED',
            message: 'Autenticação obrigatória. Forneça um token Bearer válido ou inicie sessão.'
          }
        });
      }
      return res.redirect('/login');
    }

    let loaded;
    try {
      loaded = await loadUserFromToken(token);
    } catch (err) {
      const isExpired = err.name === 'TokenExpiredError';
      const isJwtError = err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError';

      // Limpa cookies inválidos para evitar loops de redirecionamento persistentes
      res.clearCookie('onekixikila_token', { path: '/' });
      res.clearCookie('onekixikila_refresh', { path: '/' });

      // Erros esperados de JWT / utilizador não encontrado
      if (isExpired || isJwtError || err.code === 'USER_NOT_FOUND') {
        const statusCode = 401;
        const errorCode = isExpired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
        const errorMessage = isExpired
          ? 'A sua sessão expirou. Efetue login novamente.'
          : 'Token de autenticação inválido ou corrompido.';

        if (req.originalUrl.startsWith('/api/') || req.xhr || !req.accepts('html')) {
          return res.status(statusCode).json({
            success: false,
            error: { code: errorCode, message: errorMessage }
          });
        }
        return res.redirect('/login');
      }

      // Erros de conta restrita / bloqueada
      if (err.code === 'ACCOUNT_RESTRICTED' || err.code === 'ACCOUNT_TEMPORARILY_LOCKED') {
        if (req.originalUrl.startsWith('/api/') || req.xhr || !req.accepts('html')) {
          return res.status(403).json({
            success: false,
            error: { code: err.code, message: err.message }
          });
        }
        return res.redirect('/login');
      }

      // Erros inesperados (ex: falha de BD)
      throw err;
    }

    req.user = loaded.user;
    req.auth = loaded.auth;

    return next();
  } catch (error) {
    return next(error);
  }
};

/**
 * Middleware de autenticação opcional.
 * NUNCA redireciona nem devolve 401. O seu único papel é:
 *   - Se houver um token válido → preenche req.user / req.auth e prossegue;
 *   - Se não houver token, ou o token for inválido/expirado → req.user = null e prossegue.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const authenticateOptional = async (req, res, next) => {
  const token = extractToken(req);

  if (!token) {
    req.user = null;
    req.auth = null;
    return next();
  }

  try {
    const loaded = await loadUserFromToken(token);
    req.user = loaded.user;
    req.auth = loaded.auth;
  } catch (err) {
    res.clearCookie('onekixikila_token', { path: '/' });
    res.clearCookie('onekixikila_refresh', { path: '/' });
    req.user = null;
    req.auth = null;
  }

  return next();
};

module.exports = {
  authenticate,
  authenticateOptional,
  invalidateCachedUser
};