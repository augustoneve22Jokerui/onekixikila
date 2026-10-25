const withdrawalsService = require('./withdrawals.service');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Levantamentos de Fundos da Carteira Digital.
 * Faz a interface entre requisições HTTP REST e a camada de serviços (WithdrawalsService),
 * gerenciando pedidos de saída de fundos em Kwanzas (AOA) para contas bancárias (IBAN AO06),
 * carteiras móveis (Unitel Money, Multicaixa Express, e-Kwanza), cancelamentos voluntários,
 * aprovações da tesouraria e histórico auditável de saídas.
 */
class WithdrawalsController {
  /**
   * Solicita um novo levantamento de fundos da carteira digital.
   * Reserva cautelarmente os fundos no saldo retido (locked_balance) até a liquidação bancária.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async requestWithdrawal(req, res, next) {
    try {
      const idempotencyKey =
        req.headers['idempotency-key'] ||
        req.headers['x-idempotency-key'] ||
        req.body.idempotencyKey ||
        null;

      const result = await withdrawalsService.requestWithdrawal(
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
   * Consulta os dados detalhados de um pedido de levantamento por UUID (Anti-IDOR).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getWithdrawalById(req, res, next) {
    try {
      const withdrawalId = req.params.withdrawalId;
      const withdrawal = await withdrawalsService.getWithdrawalById(req.user, withdrawalId);

      return res.status(200).json({
        success: true,
        data: {
          withdrawal
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Cancela uma solicitação de levantamento pendente antes de sua liquidação bancária,
   * libertando os fundos reservados de volta para o saldo disponível da carteira.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async cancelWithdrawal(req, res, next) {
    try {
      const withdrawalId = req.params.withdrawalId;
      const result = await withdrawalsService.cancelWithdrawal(req.user, withdrawalId, {
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
   * Aprova e inicia a execução da transferência bancária de um levantamento (Ação de Tesouraria/Admin).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async approveWithdrawal(req, res, next) {
    try {
      const withdrawalId = req.params.withdrawalId;
      const result = await withdrawalsService.approveWithdrawal(req.user, withdrawalId, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          withdrawal: result.withdrawal
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Rejeita um pedido de levantamento por desconformidade ou suspeita de fraude,
   * revertendo integralmente os fundos reservados para o saldo disponível do utilizador.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async rejectWithdrawal(req, res, next) {
    try {
      const withdrawalId = req.params.withdrawalId;
      const { reason } = req.body;

      if (!reason || typeof reason !== 'string') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_REJECTION_REASON',
            message: 'A justificativa formal para a rejeição do levantamento é obrigatória.'
          }
        });
      }

      const result = await withdrawalsService.rejectWithdrawal(req.user, withdrawalId, reason.trim(), {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          withdrawal: result.withdrawal
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta o histórico paginado de levantamentos do próprio utilizador autenticado.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listMyWithdrawals(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        status: req.query.status,
        destinationType: req.query.destinationType
      };

      const result = await withdrawalsService.listUserWithdrawals(
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
   * Lista a fila geral de levantamentos da plataforma para supervisão de tesouraria e conformidade.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listAllWithdrawals(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        status: req.query.status,
        provider: req.query.provider,
        destinationType: req.query.destinationType
      };

      const result = await withdrawalsService.listAllWithdrawals(
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
const withdrawalsController = new WithdrawalsController();
withdrawalsController.requestWithdrawal = withdrawalsController.requestWithdrawal.bind(withdrawalsController);
withdrawalsController.getWithdrawalById = withdrawalsController.getWithdrawalById.bind(withdrawalsController);
withdrawalsController.cancelWithdrawal = withdrawalsController.cancelWithdrawal.bind(withdrawalsController);
withdrawalsController.approveWithdrawal = withdrawalsController.approveWithdrawal.bind(withdrawalsController);
withdrawalsController.rejectWithdrawal = withdrawalsController.rejectWithdrawal.bind(withdrawalsController);
withdrawalsController.listMyWithdrawals = withdrawalsController.listMyWithdrawals.bind(withdrawalsController);
withdrawalsController.listAllWithdrawals = withdrawalsController.listAllWithdrawals.bind(withdrawalsController);

module.exports = withdrawalsController;