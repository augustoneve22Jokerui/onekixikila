const authService = require('./auth.service');
const appConfig = require('../../config/app');
const notificationsRepository = require('../notifications/notifications.repository');
const notificationsJob = require('../../jobs/notifications.job');
const logger = require('../../shared/logging/logger');

const authLogger = logger.child({ module: 'AUTH_CONTROLLER' });

// Duração padrão dos cookies de autenticação (7 dias para navegação persistente e estável)
const SESSION_COOKIE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

// Nomes centralizados dos cookies (evita typos e facilita refactor)
const ACCESS_COOKIE = 'onekixikila_token';
const REFRESH_COOKIE = 'onekixikila_refresh';

/**
 * Deteta se estamos em produção de forma robusta.
 * `appConfig.isProduction` pode não estar definido em configurações antigas,
 * por isso usamos `NODE_ENV` como fallback.
 */
const isProduction = () => {
  if (typeof appConfig.isProduction === 'boolean') return appConfig.isProduction;
  return process.env.NODE_ENV === 'production';
};

/**
 * Opções padronizadas de cookies para sessões seguras em ambiente web.
 * Estas opções DEVEM ser reutilizadas tanto em `res.cookie` como em `res.clearCookie`,
 * caso contrário o browser pode recusar-se a apagar o cookie (bug clássico de "sessão fantasma").
 *
 * @param {number} [maxAgeMs=SESSION_COOKIE_LIFETIME_MS]
 * @returns {import('express').CookieOptions}
 */
const getAuthCookieOptions = (maxAgeMs = SESSION_COOKIE_LIFETIME_MS) => {
  const prod = isProduction();
  return {
    httpOnly: true,
    secure: prod,
    sameSite: prod ? 'strict' : 'lax',
    path: '/',
    maxAge: maxAgeMs
  };
};

/**
 * Opções usadas para LIMPAR os cookies.
 * Express exige que `path`, `sameSite` e `secure` coincidam com os usados em `res.cookie`,
 * caso contrário alguns browsers (Safari, Firefox) mantêm o cookie vivo.
 *
 * @returns {import('express').CookieOptions}
 */
const getClearCookieOptions = () => {
  const prod = isProduction();
  return {
    httpOnly: true,
    secure: prod,
    sameSite: prod ? 'strict' : 'lax',
    path: '/'
  };
};

/**
 * Limpa ambos os cookies de autenticação com as opções corretas.
 * @param {import('express').Response} res
 */
const clearAuthCookies = (res) => {
  const opts = getClearCookieOptions();
  res.clearCookie(ACCESS_COOKIE, opts);
  res.clearCookie(REFRESH_COOKIE, opts);
};

class AuthController {
  /**
   * Registo de nova conta de utilizador.
   */
  async register(req, res, next) {
    try {
      const result = await authService.register(req.body, {
        requestId: req.id,
        ipAddress: req.ip
      });

      // Inserção das notificações após registo bem-sucedido
      if (result.otpCodes) {
        const { emailOtpCode, phoneOtpCode, fullName, email, phoneNumber } = result.otpCodes;

        try {
          if (email && emailOtpCode) {
            await notificationsRepository.createNotification({
              userId: result.user.id,
              title: 'Verificação de Conta — OneKixikila',
              message: `Olá ${fullName}, o seu código de verificação de e-mail é: ${emailOtpCode}. Este código expira em 10 minutos.`,
              eventType: 'ACCOUNT_VERIFICATION',
              channel: 'EMAIL',
              status: 'PENDING',
              payload: { otpCode: emailOtpCode }
            });
            authLogger.info(`[AUTH:REGISTER] Notificação EMAIL enfileirada para ${email}`);
          }

          if (phoneNumber && phoneOtpCode) {
            await notificationsRepository.createNotification({
              userId: result.user.id,
              title: 'Código de Verificação',
              message: `O seu código OneKixikila é: ${phoneOtpCode}. Válido por 10 minutos.`,
              eventType: 'ACCOUNT_VERIFICATION',
              channel: 'SMS',
              status: 'PENDING',
              payload: { otpCode: phoneOtpCode }
            });
            authLogger.info(`[AUTH:REGISTER] Notificação SMS enfileirada para ${phoneNumber}`);
          }

          // Despacho imediato não bloqueante em segundo plano
          notificationsJob.run().then((jobResult) => {
            authLogger.info(
              `[AUTH:REGISTER:IMMEDIATE_DISPATCH] Despacho concluído: processed=${jobResult.processed}, delivered=${jobResult.delivered}, failed=${jobResult.failed}`
            );
          }).catch((jobError) => {
            authLogger.error(
              `[AUTH:REGISTER:IMMEDIATE_DISPATCH_ERROR] Falha no despacho: ${jobError.message}`
            );
          });
        } catch (notifError) {
          authLogger.error(`[AUTH:REGISTER:NOTIF_ERROR] Falha ao enfileirar notificações: ${notifError.message}`);
        }
      }

      return res.status(201).json({
        success: true,
        message: result.message,
        data: {
          user: result.user
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Início de sessão (Login).
   * Configura os cookies com validade de 7 dias para evitar o encerramento precoce da sessão.
   */
  async login(req, res, next) {
    try {
      const forwardedFor = req.headers['x-forwarded-for'];
      const ipAddress =
        (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : null) ||
        req.ip ||
        '127.0.0.1';

      const userAgent = req.headers['user-agent'] || 'UNKNOWN';

      const result = await authService.login(
        {
          ...req.body,
          ipAddress,
          userAgent
        },
        { requestId: req.id }
      );

      // Validação defensiva: nunca definir cookies com valores inválidos
      if (!result || !result.accessToken || !result.refreshToken) {
        authLogger.error(
          '[AUTH:LOGIN] authService devolveu tokens inválidos ou ausentes. Abortando definição de cookies.'
        );
        return res.status(500).json({
          success: false,
          error: {
            code: 'AUTH_INTERNAL_ERROR',
            message: 'Não foi possível concluir o início de sessão. Tente novamente.'
          }
        });
      }

      // Limpa cookies antigos ANTES de definir novos (evita conflitos de atributos)
      clearAuthCookies(res);

      const cookieOpts = getAuthCookieOptions(SESSION_COOKIE_LIFETIME_MS);
      res.cookie(ACCESS_COOKIE, result.accessToken, cookieOpts);
      res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOpts);

      return res.status(200).json({
        success: true,
        message: 'Início de sessão efetuado com sucesso.',
        data: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          user: result.user,
          session: result.session
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Confirmação de contacto ou conta por código numérico OTP.
   *
   * ⚠️ SEGURANÇA: o `userId` vem SEMPRE de `req.user` (sessão autenticada).
   * NUNCA do body — caso contrário, um atacante poderia tentar verificar
   * o OTP de outra conta.
   */
  async verifyOtp(req, res, next) {
    try {
      const userId = req.user ? req.user.id : null;
      const identifier = req.body.identifier || null;
      const type = req.body.type || 'PHONE';
      const code = req.body.code;

      const result = await authService.verifyOtp({
        type,
        code,
        userId,
        identifier
      });

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          isVerified: result.isVerified
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Reenvio de código de validação OTP.
   */
  async resendOtp(req, res, next) {
    try {
      const result = await authService.resendOtp(req.body);

      // Inserção da notificação após reenvio bem-sucedido
      if (result.otpCode && result.userId) {
        try {
          if (req.body.type === 'EMAIL') {
            await notificationsRepository.createNotification({
              userId: result.userId,
              title: 'Novo Código de Verificação — OneKixikila',
              message: `O seu novo código de verificação de e-mail é: ${result.otpCode}. Expira em 10 minutos.`,
              eventType: 'ACCOUNT_VERIFICATION',
              channel: 'EMAIL',
              status: 'PENDING',
              payload: { otpCode: result.otpCode }
            });
            authLogger.info(`[AUTH:RESEND] Notificação EMAIL enfileirada para userId=${result.userId}`);
          } else {
            await notificationsRepository.createNotification({
              userId: result.userId,
              title: 'Novo Código de Verificação',
              message: `O seu novo código OneKixikila é: ${result.otpCode}. Válido por 10 minutos.`,
              eventType: 'ACCOUNT_VERIFICATION',
              channel: 'SMS',
              status: 'PENDING',
              payload: { otpCode: result.otpCode }
            });
            authLogger.info(`[AUTH:RESEND] Notificação SMS enfileirada para userId=${result.userId}`);
          }

          // Despacho imediato em segundo plano
          notificationsJob.run().then((jobResult) => {
            authLogger.info(
              `[AUTH:RESEND:IMMEDIATE_DISPATCH] Despacho concluído: processed=${jobResult.processed}, delivered=${jobResult.delivered}`
            );
          }).catch((jobError) => {
            authLogger.error(`[AUTH:RESEND:IMMEDIATE_DISPATCH_ERROR] Falha: ${jobError.message}`);
          });
        } catch (notifError) {
          authLogger.error(`[AUTH:RESEND:NOTIF_ERROR] Falha ao enfileirar notificação: ${notifError.message}`);
        }
      }

      return res.status(200).json({
        success: true,
        message: result.message
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Solicitação de recuperação de conta / redefinição de palavra-passe.
   */
  async forgotPassword(req, res, next) {
    try {
      const result = await authService.forgotPassword(req.body.identifier);
      return res.status(200).json({
        success: true,
        message: result.message
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Confirmação de redefinição de palavra-passe com token.
   */
  async resetPassword(req, res, next) {
    try {
      const result = await authService.resetPassword(req.body);
      return res.status(200).json({
        success: true,
        message: result.message
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Alteração autenticada de palavra-passe.
   */
  async changePassword(req, res, next) {
    try {
      const userId = req.user.id;
      const result = await authService.changePassword(userId, req.body);

      // Limpa cookies com as opções corretas (mesmo path/sameSite/secure)
      clearAuthCookies(res);

      return res.status(200).json({
        success: true,
        message: result.message
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Renovação de Access Token através de Refresh Token.
   */
  async refreshToken(req, res, next) {
    try {
      const rawRefreshToken =
        req.body.refreshToken || (req.cookies ? req.cookies[REFRESH_COOKIE] : null);

      if (!rawRefreshToken) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'REFRESH_TOKEN_REQUIRED',
            message: 'Refresh Token não fornecido no corpo ou nos cookies da requisição.'
          }
        });
      }

      const result = await authService.refreshToken(rawRefreshToken, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent']
      });

      // Validação defensiva
      if (!result || !result.accessToken || !result.refreshToken) {
        authLogger.error(
          '[AUTH:REFRESH] authService devolveu tokens inválidos ou ausentes. Abortando definição de cookies.'
        );
        return res.status(500).json({
          success: false,
          error: {
            code: 'AUTH_INTERNAL_ERROR',
            message: 'Não foi possível renovar a sessão. Tente novamente.'
          }
        });
      }

      // Limpa cookies antigos ANTES de definir novos (evita conflitos de atributos)
      clearAuthCookies(res);

      const cookieOpts = getAuthCookieOptions(SESSION_COOKIE_LIFETIME_MS);
      res.cookie(ACCESS_COOKIE, result.accessToken, cookieOpts);
      res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOpts);

      return res.status(200).json({
        success: true,
        data: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Encerramento formal de sessão (Logout).
   */
  async logout(req, res, next) {
    try {
      const sessionId = req.auth ? req.auth.sessionId : null;
      const userId = req.user ? req.user.id : null;

      // Mesmo que o authService falhe, limpamos os cookies — o utilizador
      // deve conseguir sempre terminar sessão localmente.
      try {
        await authService.logout(sessionId, userId);
      } catch (logoutError) {
        authLogger.error(
          `[AUTH:LOGOUT] Falha ao revogar sessão no servidor: ${logoutError.message}. Cookies serão limpos mesmo assim.`
        );
      }

      clearAuthCookies(res);

      if (req.originalUrl.startsWith('/api/') || req.xhr || !req.accepts('html')) {
        return res.status(200).json({
          success: true,
          message: 'Sessão encerrada com sucesso.'
        });
      }

      return res.redirect('/login');
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta os dados do utilizador com sessão atualmente autenticada.
   */
  async getMe(req, res) {
    return res.status(200).json({
      success: true,
      data: {
        user: req.user
      }
    });
  }
}

// Instância singleton do controlador com vinculação de contexto
const authController = new AuthController();
authController.register = authController.register.bind(authController);
authController.login = authController.login.bind(authController);
authController.verifyOtp = authController.verifyOtp.bind(authController);
authController.resendOtp = authController.resendOtp.bind(authController);
authController.forgotPassword = authController.forgotPassword.bind(authController);
authController.resetPassword = authController.resetPassword.bind(authController);
authController.changePassword = authController.changePassword.bind(authController);
authController.refreshToken = authController.refreshToken.bind(authController);
authController.logout = authController.logout.bind(authController);
authController.getMe = authController.getMe.bind(authController);

module.exports = authController;