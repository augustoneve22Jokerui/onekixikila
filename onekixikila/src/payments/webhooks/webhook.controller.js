const webhookService = require('./webhook.service');

/**
 * Controlador de receção e processamento de webhooks de pagamento.
 * Ponto de entrada HTTP para as notificações assíncronas emitidas pela rede bancária e operadoras.
 */
class WebhookController {
  /**
   * Manipulador universal para receção de webhook baseado no parâmetro de rota :provider.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async handleProviderWebhook(req, res, next) {
    try {
      const providerParam = req.params.provider || req.query.provider;
      const headers = req.headers;
      const payload = req.body;
      const rawBody = req.rawBody || req.body;

      if (!providerParam) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_PROVIDER_IDENTIFIER',
            message: 'Identificador do prestador de pagamento ausente na rota.'
          }
        });
      }

      const result = await webhookService.processIncomingWebhook({
        provider: providerParam,
        headers,
        payload,
        rawBody
      });

      // Retorna 200 OK para confirmar a receção segura e evitar reenvios cíclicos pelo gateway
      return res.status(200).json({
        success: true,
        message: result.message || 'Webhook processado com sucesso.',
        status: result.status,
        eventId: result.eventId
      });
    } catch (error) {
      // Se a assinatura criptográfica for inválida, rejeita formalmente
      if (error.code === 'INVALID_WEBHOOK_SIGNATURE') {
        return res.status(401).json({
          success: false,
          error: {
            code: error.code,
            message: error.message
          }
        });
      }

      // Se for prestador não suportado
      if (error.code === 'UNSUPPORTED_PROVIDER') {
        return res.status(400).json({
          success: false,
          error: {
            code: error.code,
            message: error.message
          }
        });
      }

      return next(error);
    }
  }

  /**
   * Endpoint dedicado para notificações do Multicaixa Express (EMIS).
   */
  async handleMulticaixaExpress(req, res, next) {
    req.params.provider = 'multicaixa_express';
    return this.handleProviderWebhook(req, res, next);
  }

  /**
   * Endpoint dedicado para notificações da carteira Unitel Money.
   */
  async handleUnitelMoney(req, res, next) {
    req.params.provider = 'unitel_money';
    return this.handleProviderWebhook(req, res, next);
  }

  /**
   * Endpoint dedicado para notificações do serviço e-Kwanza.
   */
  async handleEKwanza(req, res, next) {
    req.params.provider = 'e_kwanza';
    return this.handleProviderWebhook(req, res, next);
  }
}

// Instância singleton do controlador vinculando os métodos
const webhookController = new WebhookController();
webhookController.handleProviderWebhook = webhookController.handleProviderWebhook.bind(webhookController);
webhookController.handleMulticaixaExpress = webhookController.handleMulticaixaExpress.bind(webhookController);
webhookController.handleUnitelMoney = webhookController.handleUnitelMoney.bind(webhookController);
webhookController.handleEKwanza = webhookController.handleEKwanza.bind(webhookController);

module.exports = webhookController;