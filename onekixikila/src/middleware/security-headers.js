const helmet = require('helmet');
const securityConfig = require('../config/security');

// Instância configurada do Helmet com base nas diretivas oficiais do projeto
const helmetMiddleware = helmet(securityConfig.helmet);

/**
 * Middleware para aplicação de cabeçalhos de proteção avançada (Hardening HTTP).
 * Configura Helmet, políticas de CSP, cabeçalhos de isolamento de contexto,
 * desativação de tecnologias obsoletas e definição granular de Permissions-Policy.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const securityHeaders = (req, res, next) => {
  // Remove indicação tecnológica do Express
  res.removeHeader('X-Powered-By');

  // Política restrita de permissões do navegador (autoriza câmara para KYC, microfone para áudio e geolocalização voluntária)
  res.setHeader(
    'Permissions-Policy',
    'camera=(self), microphone=(self), geolocation=(self), payment=(), usb=(), fullscreen=(self)'
  );

  // Política de referência para conter vazamento de URLs internas em transações
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Proteção anti-sniffing de tipo de conteúdo e clickjacking
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  // Executa o pipeline do Helmet
  return helmetMiddleware(req, res, next);
};

module.exports = securityHeaders;