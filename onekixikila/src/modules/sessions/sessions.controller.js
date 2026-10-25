const sessionsService = require('./sessions.service');

/**
 * Controlador de adaptação HTTP para auditoria e gestão de Sessões Concorrentes.
 * Trata pedidos de listagem de conexões ativas, revogação isolada de dispositivos
 * e encerramento em massa de acessos para aplicações web e móveis.
 */
class SessionsController {
  /**
   * Consulta as sessões ativas do próprio utilizador autenticado.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listMySessions(req, res, next) {
    try {
      const currentSessionId = req.auth ? req.auth.sessionId : null;
      const sessions = await sessionsService.listActiveSessions(
        req.user,
        req.user.id,
        currentSessionId
      );

      return res.status(200).json({
        success: true,
        data: {
          sessions
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta administrativa de sessões ativas de um utilizador específico.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listUserSessions(req, res, next) {
    try {
      const targetUserId = req.params.userId;
      const sessions = await sessionsService.listActiveSessions(
        req.user,
        targetUserId,
        null
      );

      return res.status(200).json({
        success: true,
        data: {
          sessions
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Revoga formalmente uma sessão individual informando o identificador da sessão.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async revokeSession(req, res, next) {
    try {
      const sessionId = req.params.sessionId;
      const reason = req.body && req.body.reason ? req.body.reason : 'USER_REVOKED';

      const result = await sessionsService.revokeSession(req.user, sessionId, reason, {
        recordAudit: req.recordAudit
      });

      // Se a sessão revogada for a sessão atual do utilizador, limpa os cookies
      if (req.auth && req.auth.sessionId === sessionId) {
        res.clearCookie('onekixikila_token', { path: '/' });
        res.clearCookie('onekixikila_refresh', { path: '/' });
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
   * Encerra todas as outras sessões ativas da conta preservando a sessão atual.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async revokeOtherSessions(req, res, next) {
    try {
      const currentSessionId = req.auth ? req.auth.sessionId : null;
      const result = await sessionsService.revokeOtherSessions(
        req.user,
        req.user.id,
        currentSessionId,
        'REVOKED_OTHER_SESSIONS',
        { recordAudit: req.recordAudit }
      );

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          revokedCount: result.revokedCount
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Encerramento em massa de todas as sessões ativas de um utilizador.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async revokeAllSessions(req, res, next) {
    try {
      const targetUserId = req.params.userId || req.user.id;
      const reason = req.body && req.body.reason ? req.body.reason : 'REVOKE_ALL';

      const result = await sessionsService.revokeAllSessions(
        req.user,
        targetUserId,
        reason,
        { recordAudit: req.recordAudit }
      );

      // Se for a própria conta, limpa os cookies de navegação
      if (req.user.id === targetUserId) {
        res.clearCookie('onekixikila_token', { path: '/' });
        res.clearCookie('onekixikila_refresh', { path: '/' });
      }

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          revokedCount: result.revokedCount
        }
      });
    } catch (error) {
      return next(error);
    }
  }
}

// Instância singleton do controlador com vinculação de contexto
const sessionsController = new SessionsController();
sessionsController.listMySessions = sessionsController.listMySessions.bind(sessionsController);
sessionsController.listUserSessions = sessionsController.listUserSessions.bind(sessionsController);
sessionsController.revokeSession = sessionsController.revokeSession.bind(sessionsController);
sessionsController.revokeOtherSessions = sessionsController.revokeOtherSessions.bind(sessionsController);
sessionsController.revokeAllSessions = sessionsController.revokeAllSessions.bind(sessionsController);

module.exports = sessionsController;