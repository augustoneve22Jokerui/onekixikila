const usersService = require('./users.service');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Utilizadores e Perfis.
 * Faz a ponte entre as requisições HTTP e a camada de serviços (UsersService),
 * garantindo respostas padronizadas e higienizadas para web, Android e iOS.
 */
class UsersController {
  /**
   * Consulta a ficha detalhada do perfil do utilizador.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getProfile(req, res, next) {
    try {
      const targetUserId = req.params.userId || req.user.id;
      const user = await usersService.getProfile(req.user, targetUserId);

      return res.status(200).json({
        success: true,
        data: {
          user
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta o perfil público higienizado de um utilizador.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getPublicProfile(req, res, next) {
    try {
      const targetUserId = req.params.userId;
      const profile = await usersService.getPublicProfile(targetUserId);

      return res.status(200).json({
        success: true,
        data: {
          profile
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Atualiza os dados de cadastro e apresentação do perfil.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async updateProfile(req, res, next) {
    try {
      const targetUserId = req.params.userId || req.user.id;
      const profile = await usersService.updateProfile(req.user, targetUserId, req.body, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: 'Perfil atualizado com sucesso.',
        data: {
          profile
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Atualiza as coordenadas geográficas de localização e consentimento de descoberta.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async updateLocation(req, res, next) {
    try {
      const targetUserId = req.params.userId || req.user.id;
      const location = await usersService.updateLocation(req.user, targetUserId, req.body);

      return res.status(200).json({
        success: true,
        message: 'Localização atualizada com sucesso.',
        data: {
          location
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Atualiza as preferências de notificação, idioma e moeda.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async updatePreferences(req, res, next) {
    try {
      const targetUserId = req.params.userId || req.user.id;
      const preferences = await usersService.updatePreferences(req.user, targetUserId, req.body);

      return res.status(200).json({
        success: true,
        message: 'Preferências atualizadas com sucesso.',
        data: {
          preferences
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Altera a função global (Role) de um utilizador (Ação administrativa).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async changeRole(req, res, next) {
    try {
      const targetUserId = req.params.userId;
      const updated = await usersService.changeRole(req.user, targetUserId, req.body.role, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: 'Papel do utilizador alterado com sucesso.',
        data: {
          user: updated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Altera o estado de uma conta (bloqueio/suspensão) com justificativa.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async changeStatus(req, res, next) {
    try {
      const targetUserId = req.params.userId;
      const updated = await usersService.changeStatus(
        req.user,
        targetUserId,
        req.body.status,
        req.body.reason,
        { recordAudit: req.recordAudit }
      );

      return res.status(200).json({
        success: true,
        message: 'Estado operacional da conta atualizado com sucesso.',
        data: {
          user: updated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Solicita o encerramento lógico (Soft Delete) de uma conta.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async deactivateAccount(req, res, next) {
    try {
      const targetUserId = req.params.userId || req.user.id;
      const result = await usersService.deactivateAccount(req.user, targetUserId, {
        recordAudit: req.recordAudit
      });

      // Se for auto-desativação pelo próprio utilizador, limpa os cookies de sessão
      if (req.user.id === targetUserId) {
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
   * Consulta paginada e filtrada de contas para administração.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listUsers(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        role: req.query.role,
        status: req.query.status,
        province: req.query.province,
        municipality: req.query.municipality,
        search: paginationParams.search
      };

      const result = await usersService.listUsers(req.user, filters, paginationParams);

      return res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error) {
      return next(error);
    }
  }
}

// Instância singleton do controlador com vinculação de contexto
const usersController = new UsersController();
usersController.getProfile = usersController.getProfile.bind(usersController);
usersController.getPublicProfile = usersController.getPublicProfile.bind(usersController);
usersController.updateProfile = usersController.updateProfile.bind(usersController);
usersController.updateLocation = usersController.updateLocation.bind(usersController);
usersController.updatePreferences = usersController.updatePreferences.bind(usersController);
usersController.changeRole = usersController.changeRole.bind(usersController);
usersController.changeStatus = usersController.changeStatus.bind(usersController);
usersController.deactivateAccount = usersController.deactivateAccount.bind(usersController);
usersController.listUsers = usersController.listUsers.bind(usersController);

module.exports = usersController;