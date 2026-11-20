const rateLimit = require('express-rate-limit');
const securityConfig = require('../config/security');
const limitsConfig = require('../config/limits');

/**
 * Função utilitária para gerar a chave identificadora de limitação de taxa.
 * Combina o identificador do utilizador autenticado (se existente) com o IP real de origem
 * para evitar evasão por rotação de endereços ou bloqueios coletivos em redes móveis (CGNAT em Angola).
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
const resolveRateLimitKey = (req) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  const realIp =
    (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : null) ||
    req.ip ||
    req.socket.remoteAddress ||
    '127.0.0.1';
  const userId = req.user && req.user.id ? req.user.id : 'anonymous';
  return `${userId}:${realIp}`;
};

/**
 * Limitador padrão global para requisições à API.
 * Margem confortável para navegação contínua na aplicação (mínimo de 300 pedidos por 15 min).
 */
const standardLimiter = rateLimit({
  windowMs: securityConfig.rateLimit.standard.windowMs || 900000,
  max: Math.max(securityConfig.rateLimit.standard.max || 100, 300),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: resolveRateLimitKey,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Demasiadas requisições enviadas. Aguarde alguns instantes antes de tentar novamente.',
        retryAfterSeconds: Math.ceil((securityConfig.rateLimit.standard.windowMs || 900000) / 1000)
      }
    });
  }
});

/**
 * Limitador para rotas de autenticação (login, registo, verificação OTP).
 * Ajustado com margem de segurança realista (50 tentativas por 15 minutos)
 * e ignora pedidos bem-sucedidos (skipSuccessfulRequests: true) para não penalizar quem acerta.
 */
const authLimiter = rateLimit({
  windowMs: securityConfig.rateLimit.auth.windowMs || 900000,
  max: Math.max(securityConfig.rateLimit.auth.max || 5, 50),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: resolveRateLimitKey,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: 'AUTH_RATE_LIMIT_EXCEEDED',
        message: 'Excesso de tentativas falhadas de autenticação. Por favor, aguarde alguns minutos antes de tentar novamente.',
        retryAfterSeconds: Math.ceil((securityConfig.rateLimit.auth.windowMs || 900000) / 1000)
      }
    });
  }
});

/**
 * Limitador específico para operações financeiras críticas (pedidos de levantamento, liquidação e transferências).
 * 30 operações por janela de 1 minuto para conter rajadas automatizadas e transações concorrentes.
 */
const financialLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: resolveRateLimitKey,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: 'FINANCIAL_BURST_LIMIT_EXCEEDED',
        message: 'Limite de frequência para transações financeiras atingido. Aguarde 60 segundos.',
        retryAfterSeconds: 60
      }
    });
  }
});

/**
 * Limitador de mensagens no chat de grupos para conter spam e inundações.
 * 30 mensagens por minuto conforme definido nas regras operacionais.
 */
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: limitsConfig.chat.maxMessagesPerMinute || 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: resolveRateLimitKey,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: 'CHAT_FLOOD_LIMIT_EXCEEDED',
        message: 'Envio de mensagens demasiado rápido. Aguarde alguns instantes.',
        retryAfterSeconds: 30
      }
    });
  }
});

module.exports = {
  standardLimiter,
  authLimiter,
  financialLimiter,
  chatLimiter
};