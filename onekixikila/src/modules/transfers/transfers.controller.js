const transfersService = require('./transfers.service');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Transferências Internas (P2P).
 * Faz a interface entre requisições HTTP REST e a camada de serviços (TransfersService),
 * gerenciando transferências diretas de fundos entre membros em Kwanzas (AOA),
 * consulta de comprovativos e históricos de envios e recebimentos.
 */
class TransfersController {
  /**
   * Executa uma transferência financeira interna direta entre membros da plataforma.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async transferFunds(req, res, next) {
    try {
      const idempotencyKey =
        req.headers['idempotency-key'] ||
        req.headers['x-idempotency-key'] ||
        req.body.idempotencyKey ||
        null;

      const result = await transfersService.transferFunds(
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

      return res.status(200).json({
        success: true,
        message: result.message,
        data: result
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta os dados detalhados e o recibo de uma transferência por UUID (Anti-IDOR).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getTransferById(req, res, next) {
    try {
      const transferId = req.params.transferId;
      const transfer = await transfersService.getTransferById(req.user, transferId);

      return res.status(200).json({
        success: true,
        data: {
          transfer
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta o histórico paginado de transferências enviadas pelo utilizador autenticado.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listMySentTransfers(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        status: req.query.status
      };

      const result = await transfersService.listUserSentTransfers(
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
   * Consulta o histórico paginado de transferências recebidas pelo utilizador autenticado.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listMyReceivedTransfers(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        status: req.query.status
      };

      const result = await transfersService.listUserReceivedTransfers(
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
const transfersController = new TransfersController();
transfersController.transferFunds = transfersController.transferFunds.bind(transfersController);
transfersController.getTransferById = transfersController.getTransferById.bind(transfersController);
transfersController.listMySentTransfers = transfersController.listMySentTransfers.bind(transfersController);
transfersController.listMyReceivedTransfers = transfersController.listMyReceivedTransfers.bind(transfersController);

module.exports = transfersController;