const payoutsService = require('./payouts.service');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Desembolsos e Payouts de Kixikila.
 * Faz a interface entre as requisições HTTP REST e a camada de serviços (PayoutsService),
 * tratando a execução do pagamento do bolo de rotação ao beneficiário da vez,
 * retenções preventivas por disputa, consulta de comprovativos e extratos de payouts.
 */
class PayoutsController {
  /**
   * Executa ou agenda o desembolso (payout) do montante acumulado da Kixikila para o beneficiário do turno.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async executePayout(req, res, next) {
    try {
      const idempotencyKey =
        req.headers['idempotency-key'] ||
        req.headers['x-idempotency-key'] ||
        req.body.idempotencyKey ||
        null;

      const result = await payoutsService.executePayout(
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

      const statusCode = result.status === 'SETTLED' ? 200 : 202;

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
   * Consulta os dados detalhados de um desembolso pelo seu identificador primário UUID.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getPayoutById(req, res, next) {
    try {
      const payoutId = req.params.payoutId;
      const payout = await payoutsService.getPayoutById(req.user, payoutId);

      return res.status(200).json({
        success: true,
        data: {
          payout
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Retém preventivamente ou suspende temporariamente um desembolso por motivo de litígio ou auditoria.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async holdPayout(req, res, next) {
    try {
      const payoutId = req.params.payoutId;
      const { reason } = req.body;

      if (!reason || typeof reason !== 'string') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_HOLD_REASON',
            message: 'A justificativa formal para a retenção preventiva do desembolso é obrigatória.'
          }
        });
      }

      const result = await payoutsService.holdPayout(req.user, payoutId, reason.trim(), {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          payout: result.payout
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Liberta um desembolso previamente retido após deliberação favorável de auditoria ou liderança.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async releasePayout(req, res, next) {
    try {
      const payoutId = req.params.payoutId;
      const result = await payoutsService.releasePayout(req.user, payoutId, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          payout: result.payout
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Lista o histórico paginado de desembolsos realizados num grupo de Kixikila.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listGroupPayouts(req, res, next) {
    try {
      const groupId = req.params.groupId || req.query.groupId;
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        status: req.query.status,
        cycleNumber: req.query.cycleNumber ? Number(req.query.cycleNumber) : undefined
      };

      const result = await payoutsService.listGroupPayouts(
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
   * Consulta os valores e turnos de bolo recebidos pelo próprio utilizador autenticado em todos os seus grupos.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listMyPayouts(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        status: req.query.status
      };

      const result = await payoutsService.listUserPayouts(
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
const payoutsController = new PayoutsController();
payoutsController.executePayout = payoutsController.executePayout.bind(payoutsController);
payoutsController.getPayoutById = payoutsController.getPayoutById.bind(payoutsController);
payoutsController.holdPayout = payoutsController.holdPayout.bind(payoutsController);
payoutsController.releasePayout = payoutsController.releasePayout.bind(payoutsController);
payoutsController.listGroupPayouts = payoutsController.listGroupPayouts.bind(payoutsController);
payoutsController.listMyPayouts = payoutsController.listMyPayouts.bind(payoutsController);

module.exports = payoutsController;