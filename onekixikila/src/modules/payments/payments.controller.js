const paymentsService = require('./payments.service');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Pagamentos e Checkout Externo.
 * Mapeia requisições de inicialização de pagamento, polling ativo de status,
 * cancelamento de ordens pendentes e histórico de pagamentos para clientes web e móveis.
 */
class PaymentsController {
  /**
   * Inicia um pedido de pagamento junto a um prestador externo angolano.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async initiatePayment(req, res, next) {
    try {
      const idempotencyKey =
        req.headers['idempotency-key'] ||
        req.headers['x-idempotency-key'] ||
        req.body.idempotencyKey ||
        null;

      const result = await paymentsService.initiatePayment(
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
   * Consulta os detalhes de uma ordem de pagamento por UUID.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getPaymentById(req, res, next) {
    try {
      const paymentId = req.params.paymentId;
      const payment = await paymentsService.getPaymentRequestById(req.user, paymentId);

      return res.status(200).json({
        success: true,
        data: {
          payment
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Executa a checagem ativa do estado de um pagamento no prestador (fallback para atrasos de webhook).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async checkPaymentStatus(req, res, next) {
    try {
      const paymentId = req.params.paymentId;
      const payment = await paymentsService.checkPaymentStatus(req.user, paymentId);

      return res.status(200).json({
        success: true,
        data: {
          payment
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Cancela uma ordem de pagamento pendente.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async cancelPayment(req, res, next) {
    try {
      const paymentId = req.params.paymentId;
      const result = await paymentsService.cancelPaymentRequest(req.user, paymentId, {
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
   * Consulta o histórico paginado de pedidos de pagamento do próprio utilizador autenticado.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listMyPayments(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        status: req.query.status,
        provider: req.query.provider
      };

      const result = await paymentsService.listUserPaymentRequests(
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
const paymentsController = new PaymentsController();
paymentsController.initiatePayment = paymentsController.initiatePayment.bind(paymentsController);
paymentsController.getPaymentById = paymentsController.getPaymentById.bind(paymentsController);
paymentsController.checkPaymentStatus = paymentsController.checkPaymentStatus.bind(paymentsController);
paymentsController.cancelPayment = paymentsController.cancelPayment.bind(paymentsController);
paymentsController.listMyPayments = paymentsController.listMyPayments.bind(paymentsController);

module.exports = paymentsController;