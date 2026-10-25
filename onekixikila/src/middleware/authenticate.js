const jwt = require('jsonwebtoken');
const securityConfig = require('../config/security');
const { queryOne } = require('../database/query');

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

    // Validação criptográfica do JWT com os parâmetros de segurança estabelecidos
    let decoded;
    try {
      decoded = jwt.verify(token, securityConfig.jwt.accessTokenSecret, {
        algorithms: [securityConfig.jwt.algorithm],
        issuer: securityConfig.jwt.issuer,
        audience: securityConfig.jwt.audience
      });
    } catch (jwtError) {
      const isExpired = jwtError.name === 'TokenExpiredError';
      const statusCode = 401;
      const errorCode = isExpired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
      const errorMessage = isExpired
        ? 'A sua sessão expirou. Efetue login novamente.'
        : 'Token de autenticação inválido ou corrompido.';

      if (req.originalUrl.startsWith('/api/') || req.xhr || !req.accepts('html')) {
        return res.status(statusCode).json({
          success: false,
          error: {
            code: errorCode,
            message: errorMessage
          }
        });
      }
      return res.redirect('/login');
    }

    // Consulta do utilizador na base de dados com validação de status
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
      return res.status(401).json({
        success: false,
        error: {
          code: 'USER_NOT_FOUND',
          message: 'Utilizador associado ao token não existe ou foi removido.'
        }
      });
    }

    // Verificação de bloqueios e restrições de segurança
    if (user.status === 'BLOCKED' || user.status === 'SUSPENDED') {
      return res.status(403).json({
        success: false,
        error: {
          code: 'ACCOUNT_RESTRICTED',
          message: `A sua conta encontra-se no estado [${user.status}]. Contacte o suporte da OneKixikila.`
        }
      });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({
        success: false,
        error: {
          code: 'ACCOUNT_TEMPORARILY_LOCKED',
          message: 'Conta temporariamente bloqueada por excesso de tentativas falhadas.'
        }
      });
    }

    // Injeta os dados do utilizador e da sessão validada no objeto da requisição
    req.user = Object.freeze({
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

    req.auth = Object.freeze({
      tokenId: decoded.jti || null,
      sessionId: decoded.sessionId || null,
      issuedAt: decoded.iat,
      expiresAt: decoded.exp
    });

    return next();
  } catch (error) {
    return next(error);
  }
};

/**
 * Middleware de autenticação opcional.
 * Caso haja token válido, preenche req.user; caso contrário, permite continuar sem rejeição.
 */
const authenticateOptional = async (req, res, next) => {
  const token = extractToken(req);
  if (!token) {
    req.user = null;
    return next();
  }
  return authenticate(req, res, next);
};

module.exports = {
  authenticate,
  authenticateOptional
};