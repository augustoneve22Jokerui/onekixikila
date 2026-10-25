const walletService = require('./wallet.service');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Carteira Interna (Wallet).
 * Faz a mediação entre requisições HTTP REST e a camada de serviços (WalletService),
 * tratando consultas de saldo (contabilístico, disponível e retido em AOA), extratos paginados,
 * recibos de operações financeiras e intervenções de conformidade (bloqueio/desbloqueio cautelar).
 */
class WalletController {
  /**
   * Consulta os dados cadastrais e saldos da carteira do próprio utilizador autenticado.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getMyWallet(req, res, next) {
    try {
      const wallet = await walletService.getUserWallet(req.user, req.user.id);

      return res.status(200).json({
        success: true,
        data: {
          wallet
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta os dados de uma carteira específica por UUID (Anti-IDOR).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getWalletById(req, res, next) {
    try {
      const walletId = req.params.walletId;
      const wallet = await walletService.getWalletById(req.user, walletId);

      return res.status(200).json({
        success: true,
        data: {
          wallet
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta o extrato financeiro unificado da carteira com suporte a paginação e filtros.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getStatement(req, res, next) {
    try {
      const walletId = req.params.walletId;
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        operationType: req.query.operationType,
        startDate: req.query.startDate,
        endDate: req.query.endDate
      };

      const result = await walletService.getWalletStatement(
        req.user,
        walletId,
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
   * Consulta o recibo ou comprovativo oficial estruturado de uma operação contábil da carteira.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getReceipt(req, res, next) {
    try {
      const transactionId = req.params.transactionId;
      const receipt = await walletService.getTransactionReceipt(req.user, transactionId);

      return res.status(200).json({
        success: true,
        data: {
          receipt
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Congela preventivamente a carteira de um utilizador por suspeita ou auditoria (Ação administrativa).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async freezeWallet(req, res, next) {
    try {
      const walletId = req.params.walletId;
      const { reason } = req.body;

      if (!reason || typeof reason !== 'string') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_FREEZE_REASON',
            message: 'A justificativa formal para o congelamento da carteira é obrigatória.'
          }
        });
      }

      const updated = await walletService.freezeWallet(req.user, walletId, reason.trim(), {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: 'Carteira congelada preventivamente.',
        data: {
          wallet: updated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Descongela a carteira restabelecendo a operação regular de saldos (Ação administrativa).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async unfreezeWallet(req, res, next) {
    try {
      const walletId = req.params.walletId;
      const updated = await walletService.unfreezeWallet(req.user, walletId, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: 'Carteira descongelada com sucesso.',
        data: {
          wallet: updated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Lista as carteiras cadastradas na plataforma para o painel financeiro e de auditoria.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listWallets(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        status: req.query.status,
        hasBalance: req.query.hasBalance !== undefined ? req.query.hasBalance === 'true' || req.query.hasBalance === '1' : undefined
      };

      const result = await walletService.listWallets(req.user, filters, paginationParams);

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
const walletController = new WalletController();
walletController.getMyWallet = walletController.getMyWallet.bind(walletController);
walletController.getWalletById = walletController.getWalletById.bind(walletController);
walletController.getStatement = walletController.getStatement.bind(walletController);
walletController.getReceipt = walletController.getReceipt.bind(walletController);
walletController.freezeWallet = walletController.freezeWallet.bind(walletController);
walletController.unfreezeWallet = walletController.unfreezeWallet.bind(walletController);
walletController.listWallets = walletController.listWallets.bind(walletController);

module.exports = walletController;