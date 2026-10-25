const rateLimit = require('express-rate-limit');
const securityConfig = require('../config/security');
const limitsConfig = require('../config/limits');

/**
 * Função utilitária para gerar a chave identificadora de limitação de taxa.
 * Combina o identificador do utilizador autenticado (se existente) com o IP real de origem
 * para evitar evasão por rotação de endereços ou bloqueios coletivos em redes móveis (NAT em Angola).
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
const resolveRateLimitKey = (req) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  const realIp = (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : null) || req.ip || '127.0.0.1';
  const userId = req.user && req.user.id ? req.user.id : 'anonymous';
  return `${userId}:${realIp}`;
};

/**
 * Limitador padrão global para requisições à API.
 * 100 requisições por janela de 15 minutos (configurável via ambiente).
 */
const standardLimiter = rateLimit({
  windowMs: securityConfig.rateLimit.standard.windowMs,
  max: securityConfig.rateLimit.standard.max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: resolveRateLimitKey,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Demasiadas requisições enviadas. Aguarde alguns minutos antes de tentar novamente.',
        retryAfterSeconds: Math.ceil(securityConfig.rateLimit.standard.windowMs / 1000)
      }
    });
  }
});

/**
 * Limitador estrito para rotas de autenticação, recuperação de conta e submissão de credenciais.
 * 5 tentativas por janela de 15 minutos para proteção contra força bruta.
 */
const authLimiter = rateLimit({
  windowMs: securityConfig.rateLimit.auth.windowMs,
  max: securityConfig.rateLimit.auth.max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: resolveRateLimitKey,
  skipSuccessfulRequests: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: {
        code: 'AUTH_RATE_LIMIT_EXCEEDED',
        message: 'Excesso de tentativas de autenticação ou emissão de códigos. Tente novamente mais tarde.',
        retryAfterSeconds: Math.ceil(securityConfig.rateLimit.auth.windowMs / 1000)
      }
    });
  }
});

/**
 * Limitador específico para operações financeiras críticas (pedidos de levantamento, liquidação e transferências).
 * 10 operações por janela de 1 minuto para conter rajadas automatizadas e transações concorrentes.
 */
const financialLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10,
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
  max: limitsConfig.chat.maxMessagesPerMinute,
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