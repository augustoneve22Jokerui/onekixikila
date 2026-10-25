const authService = require('./auth.service');
const appConfig = require('../../config/app');

/**
 * Opções padronizadas de cookies para sessões seguras em ambiente web.
 */
const getAuthCookieOptions = (maxAgeMs) => ({
  httpOnly: true,
  secure: appConfig.isProduction,
  sameSite: appConfig.isProduction ? 'strict' : 'lax',
  path: '/',
  maxAge: maxAgeMs
});

/**
 * Controlador de adaptação HTTP para o ciclo de vida de Autenticação e Gestão de Contas.
 * Converte requisições HTTP, orquestra cabeçalhos e cookies seguros (`HttpOnly`),
 * delega ao `authService` e devolve respostas estruturadas para aplicações web e móveis.
 */
class AuthController {
  /**
   * Registo de nova conta de utilizador.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async register(req, res, next) {
    try {
      const result = await authService.register(req.body, {
        requestId: req.id,
        ipAddress: req.ip
      });

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
   * Início de sessão (Login) com emissão de Access Token e Refresh Token.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
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

      // Define cookies HttpOnly para suportar navegação web transparente
      res.cookie(
        'onekixikila_token',
        result.accessToken,
        getAuthCookieOptions(15 * 60 * 1000) // 15 minutos
      );

      res.cookie(
        'onekixikila_refresh',
        result.refreshToken,
        getAuthCookieOptions(7 * 24 * 60 * 60 * 1000) // 7 dias
      );

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
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async verifyOtp(req, res, next) {
    try {
      const userId = req.user ? req.user.id : req.body.userId;

      const result = await authService.verifyOtp({
        ...req.body,
        userId
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
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async resendOtp(req, res, next) {
    try {
      const result = await authService.resendOtp(req.body);

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
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
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
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
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
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async changePassword(req, res, next) {
    try {
      const userId = req.user.id;
      const result = await authService.changePassword(userId, req.body);

      // Limpa os cookies para exigir nova autenticação com a credencial atualizada
      res.clearCookie('onekixikila_token', { path: '/' });
      res.clearCookie('onekixikila_refresh', { path: '/' });

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
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async refreshToken(req, res, next) {
    try {
      const rawRefreshToken =
        req.body.refreshToken || (req.cookies ? req.cookies.onekixikila_refresh : null);

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

      res.cookie(
        'onekixikila_token',
        result.accessToken,
        getAuthCookieOptions(15 * 60 * 1000)
      );

      res.cookie(
        'onekixikila_refresh',
        result.refreshToken,
        getAuthCookieOptions(7 * 24 * 60 * 60 * 1000)
      );

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
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async logout(req, res, next) {
    try {
      const sessionId = req.auth ? req.auth.sessionId : null;
      const userId = req.user ? req.user.id : null;

      await authService.logout(sessionId, userId);

      res.clearCookie('onekixikila_token', { path: '/' });
      res.clearCookie('onekixikila_refresh', { path: '/' });

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
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
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