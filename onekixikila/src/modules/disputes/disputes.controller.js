const disputesService = require('./disputes.service');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Disputas e Resolução de Contestações.
 * Mapeia requisições de abertura de contestações, consulta de autos, instrução probatória,
 * deliberação técnica de arbitragem e relatórios administrativos de governança.
 */
class DisputesController {
  /**
   * Abre formalmente uma contestação.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async openDispute(req, res, next) {
    try {
      const result = await disputesService.openDispute(req.user, req.body, {
        requestId: req.id,
        recordAudit: req.recordAudit
      });

      return res.status(201).json({
        success: true,
        message: result.message,
        data: {
          dispute: result.dispute
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta os detalhes de uma disputa pelo seu identificador primário UUID.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getDisputeById(req, res, next) {
    try {
      const disputeId = req.params.disputeId;
      const dispute = await disputesService.getDisputeById(req.user, disputeId);

      return res.status(200).json({
        success: true,
        data: {
          dispute
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Promove o estado de uma contestação para fase investigativa (UNDER_INVESTIGATION).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async markUnderInvestigation(req, res, next) {
    try {
      const disputeId = req.params.disputeId;
      const updated = await disputesService.markUnderInvestigation(req.user, disputeId, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: 'Disputa colocada em fase de instrução e investigação.',
        data: {
          dispute: updated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Delibera e conclui uma disputa emitindo o parecer formal de arbitragem.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async resolveDispute(req, res, next) {
    try {
      const disputeId = req.params.disputeId;
      const result = await disputesService.resolveDispute(req.user, disputeId, req.body, {
        requestId: req.id,
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          dispute: result.dispute
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta o histórico de disputas vinculadas ao próprio utilizador autenticado.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listMyDisputes(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        status: req.query.status,
        category: req.query.category
      };

      const result = await disputesService.listUserDisputes(
        req.user,
        filters,
        paginationParams
      );

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
   * Consulta a fila geral de disputas para o painel de auditoria e conformidade (ADMIN/AUDITOR).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listAllDisputes(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        status: req.query.status,
        category: req.query.category
      };

      const result = await disputesService.listAllDisputes(
        req.user,
        filters,
        paginationParams
      );

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
const disputesController = new DisputesController();
disputesController.openDispute = disputesController.openDispute.bind(disputesController);
disputesController.getDisputeById = disputesController.getDisputeById.bind(disputesController);
disputesController.markUnderInvestigation = disputesController.markUnderInvestigation.bind(disputesController);
disputesController.resolveDispute = disputesController.resolveDispute.bind(disputesController);
disputesController.listMyDisputes = disputesController.listMyDisputes.bind(disputesController);
disputesController.listAllDisputes = disputesController.listAllDisputes.bind(disputesController);

module.exports = disputesController;