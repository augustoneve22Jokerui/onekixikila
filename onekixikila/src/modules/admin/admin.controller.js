const adminService = require('./admin.service');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Administração e Governança Geral.
 * Faz a interface entre os pedidos HTTP REST e o serviço administrativo (`adminService`),
 * disponibilizando métricas executivas, intervenções disciplinares em contas de utilizadores,
 * supervisão operacional de grupos de Kixikila, configurações do sistema e relatórios de auditoria.
 */
class AdminController {
  /**
   * Consulta os indicadores e métricas consolidadas do painel executivo (Dashboard).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getDashboardOverview(req, res, next) {
    try {
      const overview = await adminService.getDashboardOverview(req.user);

      return res.status(200).json({
        success: true,
        data: {
          overview
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta a ficha técnica detalhada de um utilizador específico para auditoria.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getUserDetails(req, res, next) {
    try {
      const userId = req.params.userId;
      const userDetails = await adminService.getUserDetails(req.user, userId);

      return res.status(200).json({
        success: true,
        data: {
          user: userDetails
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Altera administrativamente o papel global (Role) de um utilizador.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async updateUserRole(req, res, next) {
    try {
      const userId = req.params.userId;
      const { role } = req.body;

      if (!role || typeof role !== 'string') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_ROLE',
            message: 'O campo role é obrigatório.'
          }
        });
      }

      const updated = await adminService.updateUserRole(req.user, userId, role.toUpperCase(), {
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
   * Altera o estado operacional de uma conta (Bloqueio, Suspensão ou Reativação).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async updateUserStatus(req, res, next) {
    try {
      const userId = req.params.userId;
      const { status, reason } = req.body;

      if (!status || !reason) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_STATUS_OR_REASON',
            message: 'Os campos status e reason são obrigatórios para a intervenção.'
          }
        });
      }

      const updated = await adminService.updateUserStatus(
        req.user,
        userId,
        status.toUpperCase(),
        String(reason).trim(),
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
   * Consulta os dados aprofundados de um grupo de Kixikila para supervisão administrativa.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getGroupDetails(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const groupDetails = await adminService.getGroupDetails(req.user, groupId);

      return res.status(200).json({
        success: true,
        data: {
          group: groupDetails
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Altera administrativamente o estado de um grupo (ex: pausar ou suspender por litígio).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async updateGroupStatus(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const { status, reason } = req.body;

      if (!status || !reason) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_GROUP_STATUS_OR_REASON',
            message: 'Os campos status e reason são obrigatórios para intervenção no grupo.'
          }
        });
      }

      const updated = await adminService.updateGroupStatus(
        req.user,
        groupId,
        status.toUpperCase(),
        String(reason).trim(),
        { recordAudit: req.recordAudit }
      );

      return res.status(200).json({
        success: true,
        message: 'Estado do grupo de Kixikila atualizado administrativamente.',
        data: {
          group: updated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Substitui compulsoriamente a liderança de um grupo por deliberação de contingência.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async forceChangeGroupLeader(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const { newLeaderId, reason } = req.body;

      if (!newLeaderId || !reason) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_NEW_LEADER_OR_REASON',
            message: 'Os campos newLeaderId e reason são obrigatórios.'
          }
        });
      }

      const result = await adminService.forceChangeGroupLeader(
        req.user,
        groupId,
        newLeaderId,
        String(reason).trim(),
        { recordAudit: req.recordAudit }
      );

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          groupId: result.groupId,
          newLeaderId: result.newLeaderId
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta a lista de grupos para esteira de supervisão administrativa com paginação e filtros.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listGroups(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        status: req.query.status,
        frequency: req.query.frequency,
        search: paginationParams.search
      };

      const result = await adminService.listGroups(req.user, filters, paginationParams);

      return res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta os registos de auditoria institucional (`audit_events`) com filtros e paginação.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listAuditLogs(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        action: req.query.action,
        resourceType: req.query.resourceType,
        actorUserId: req.query.actorUserId,
        startDate: req.query.startDate,
        endDate: req.query.endDate
      };

      const result = await adminService.listAuditLogs(req.user, filters, paginationParams);

      return res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta os parâmetros e configurações vigentes da plataforma para o painel.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getSystemSettings(req, res, next) {
    try {
      const settings = await adminService.getSystemSettings(req.user);

      return res.status(200).json({
        success: true,
        data: {
          settings
        }
      });
    } catch (error) {
      return next(error);
    }
  }
}

// Instância singleton do controlador com vinculação de contexto
const adminController = new AdminController();
adminController.getDashboardOverview = adminController.getDashboardOverview.bind(adminController);
adminController.getUserDetails = adminController.getUserDetails.bind(adminController);
adminController.updateUserRole = adminController.updateUserRole.bind(adminController);
adminController.updateUserStatus = adminController.updateUserStatus.bind(adminController);
adminController.getGroupDetails = adminController.getGroupDetails.bind(adminController);
adminController.updateGroupStatus = adminController.updateGroupStatus.bind(adminController);
adminController.forceChangeGroupLeader = adminController.forceChangeGroupLeader.bind(adminController);
adminController.listGroups = adminController.listGroups.bind(adminController);
adminController.listAuditLogs = adminController.listAuditLogs.bind(adminController);
adminController.getSystemSettings = adminController.getSystemSettings.bind(adminController);

module.exports = adminController;