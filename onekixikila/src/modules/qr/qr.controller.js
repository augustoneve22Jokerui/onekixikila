const qrService = require('./qr.service');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Códigos QR da OneKixikila.
 * Gerencia a geração de QR Codes dinâmicos para convites de adesão a grupos,
 * cobranças e recebimentos de carteira, resolução segura de payloads (scanner),
 * liquidação presencial e revogação preventiva anti-repetição.
 */
class QrController {
  /**
   * Gera um Código QR dinâmico e seguro para convite de adesão a um grupo de Kixikila.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async generateGroupInviteQr(req, res, next) {
    try {
      const groupId = req.params.groupId || req.body.groupId;
      const result = await qrService.generateGroupInviteQr(req.user, groupId, req.body, {
        requestId: req.id,
        recordAudit: req.recordAudit
      });

      return res.status(201).json({
        success: true,
        message: 'Código QR de convite gerado com sucesso.',
        data: result
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Gera um Código QR dinâmico para cobrança ou recebimento de valores na carteira digital (AOA).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async generatePaymentQr(req, res, next) {
    try {
      const result = await qrService.generatePaymentQr(req.user, req.body, {
        requestId: req.id,
        recordAudit: req.recordAudit
      });

      return res.status(201).json({
        success: true,
        message: 'Código QR de pagamento gerado com sucesso.',
        data: result
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Resolve e decodifica de forma segura o token lido pelo leitor de QR Code (Scanner).
   * Identifica a finalidade (convite de grupo, pagamento, transferência direta) sem expor dados privados.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async scanQrToken(req, res, next) {
    try {
      const tokenCode = req.params.tokenCode || req.query.token || req.body.tokenCode;

      if (!tokenCode) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_QR_TOKEN',
            message: 'O código do token QR é obrigatório para validação.'
          }
        });
      }

      const result = await qrService.resolveQrToken(req.user, tokenCode.trim());

      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Executa a liquidação ou pagamento autorizado a partir de um Código QR de cobrança previamente escaneado.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async payQr(req, res, next) {
    try {
      const idempotencyKey =
        req.headers['idempotency-key'] ||
        req.headers['x-idempotency-key'] ||
        req.body.idempotencyKey ||
        null;

      const result = await qrService.consumePaymentQr(
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
   * Revoga preventivamente um Código QR ativo emitido pelo utilizador.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async revokeQr(req, res, next) {
    try {
      const qrTokenId = req.params.qrTokenId;
      const result = await qrService.revokeQrToken(req.user, qrTokenId, {
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
   * Lista os Códigos QR ativos e gerados pelo próprio utilizador autenticado.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listMyQrTokens(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        qrType: req.query.qrType,
        status: req.query.status
      };

      const result = await qrService.listUserQrTokens(
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
const qrController = new QrController();
qrController.generateGroupInviteQr = qrController.generateGroupInviteQr.bind(qrController);
qrController.generatePaymentQr = qrController.generatePaymentQr.bind(qrController);
qrController.scanQrToken = qrController.scanQrToken.bind(qrController);
qrController.payQr = qrController.payQr.bind(qrController);
qrController.revokeQr = qrController.revokeQr.bind(qrController);
qrController.listMyQrTokens = qrController.listMyQrTokens.bind(qrController);

module.exports = qrController;