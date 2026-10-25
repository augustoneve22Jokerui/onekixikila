const depositsService = require('./deposits.service');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Depósitos na Carteira Digital.
 * Trata requisições de criação de ordens de depósito em Kwanzas (AOA), cancelamento prévio,
 * consulta de estado e histórico paginado para a web, aplicações Android e iOS.
 */
class DepositsController {
  /**
   * Inicia um pedido de depósito na carteira interna.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async createDeposit(req, res, next) {
    try {
      const idempotencyKey =
        req.headers['idempotency-key'] ||
        req.headers['x-idempotency-key'] ||
        req.body.idempotencyKey ||
        null;

      const result = await depositsService.createDeposit(
        req.user,
        {
          ...req.body,
          idempotencyKey
        },
        {
          requestId: req.id,
          ipAddress: req.ip,
          recordAudit: req.recordAudit
        }
      );

      return res.status(202).json({
        success: true,
        message: result.message,
        data: result
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta os detalhes de um depósito pelo seu identificador primário UUID.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getDepositById(req, res, next) {
    try {
      const depositId = req.params.depositId;
      const deposit = await depositsService.getDepositById(req.user, depositId);

      return res.status(200).json({
        success: true,
        data: {
          deposit
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Cancela uma intenção de depósito pendente antes de sua liquidação ou expiração.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async cancelDeposit(req, res, next) {
    try {
      const depositId = req.params.depositId;
      const result = await depositsService.cancelDeposit(req.user, depositId, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta o histórico paginado de depósitos do próprio utilizador autenticado.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listMyDeposits(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        status: req.query.status,
        provider: req.query.provider
      };

      const result = await depositsService.listUserDeposits(
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
const depositsController = new DepositsController();
depositsController.createDeposit = depositsController.createDeposit.bind(depositsController);
depositsController.getDepositById = depositsController.getDepositById.bind(depositsController);
depositsController.cancelDeposit = depositsController.cancelDeposit.bind(depositsController);
depositsController.listMyDeposits = depositsController.listMyDeposits.bind(depositsController);

module.exports = depositsController;