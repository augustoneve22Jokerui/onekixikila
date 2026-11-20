const contributionsService = require('./contributions.service');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Contribuições e Quotas de Kixikila.
 * Recebe e trata requisições de pagamento imediato (carteira interna ou gateways externos),
 * consulta de extratos de quotas por grupo ou utilizador, detalhes individuais e dispensa de multas de mora.
 */
class ContributionsController {
  /**
   * Processa o pagamento ou intenção de liquidação de uma quota de Kixikila.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async payContribution(req, res, next) {
    try {
      const idempotencyKey =
        req.headers['idempotency-key'] ||
        req.headers['x-idempotency-key'] ||
        req.body.idempotencyKey ||
        null;

      const result = await contributionsService.payContribution(
        req.user,
        {
          ...req.body,
          idempotencyKey
        },
        {
          requestId: req.id,
          recordAudit: req.recordAudit
        }
      );

      const statusCode = result.status === 'CONFIRMED' ? 200 : 202;

      return res.status(statusCode).json({
        success: true,
        message: result.message,
        data: result
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta os dados detalhados de uma contribuição específica.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getContributionById(req, res, next) {
    try {
      const contributionId = req.params.contributionId;
      const contribution = await contributionsService.getContributionById(req.user, contributionId);

      return res.status(200).json({
        success: true,
        data: {
          contribution
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Dispensa ou perdoa formalmente a multa de mora aplicada a uma obrigação (Ação de Liderança).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async waiveLateFee(req, res, next) {
    try {
      const obligationId = req.params.obligationId;
      const { reason } = req.body;

      const result = await contributionsService.waiveLateFee(req.user, obligationId, reason, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          obligation: result.obligation
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta paginada e filtrada das contribuições arrecadadas em determinado grupo.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listGroupContributions(req, res, next) {
    try {
      const groupId = req.params.groupId || req.query.groupId;
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        status: req.query.status,
        cycleNumber: req.query.cycleNumber ? Number(req.query.cycleNumber) : undefined,
        roundNumber: req.query.roundNumber ? Number(req.query.roundNumber) : undefined
      };

      const result = await contributionsService.listGroupContributions(
        req.user,
        groupId,
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
   * Consulta o histórico de quotas liquidadas pelo próprio utilizador autenticado em todos os seus grupos.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listMyContributions(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        status: req.query.status
      };

      const result = await contributionsService.listUserContributions(
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
const contributionsController = new ContributionsController();
contributionsController.payContribution = contributionsController.payContribution.bind(contributionsController);
contributionsController.getContributionById = contributionsController.getContributionById.bind(contributionsController);
contributionsController.waiveLateFee = contributionsController.waiveLateFee.bind(contributionsController);
contributionsController.listGroupContributions = contributionsController.listGroupContributions.bind(contributionsController);
contributionsController.listMyContributions = contributionsController.listMyContributions.bind(contributionsController);

module.exports = contributionsController;