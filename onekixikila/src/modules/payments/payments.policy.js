const { USER_ROLES } = require('../../shared/constants/roles');
const { USER_STATUSES, PAYMENT_REQUEST_STATUSES } = require('../../shared/constants/statuses');
const paymentsConfig = require('../../config/payments');

// Canais e prestadores homologados para recepção e emissão de pagamentos em Angola
const SUPPORTED_PROVIDERS = new Set(['MULTICAIXA_EXPRESS', 'UNITEL_MONEY', 'E_KWANZA']);
const SUPPORTED_CHANNELS = new Set(['MOBILE', 'QR_CODE', 'USSD', 'WEB']);

// Papéis com permissão formal para consultar ou gerir transações de pagamento globalmente
const PAYMENT_AUDIT_ROLES = new Set([USER_ROLES.ADMIN, USER_ROLES.AUDITOR, USER_ROLES.FINANCIAL_OPERATOR]);

/**
 * Políticas de autorização, integridade de checkout e regras de segurança Anti-IDOR
 * para Pedidos de Pagamento e Integração com Gateways Angolanos.
 */
class PaymentsPolicy {
  /**
   * Avalia se um utilizador pode iniciar um pedido de pagamento externo.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canInitiatePayment(actingUser) {
    if (!actingUser) {
      return { allowed: false, reason: 'Autenticação necessária para iniciar pedidos de pagamento.' };
    }

    if (actingUser.status === USER_STATUSES.BLOCKED || actingUser.status === USER_STATUSES.SUSPENDED) {
      return {
        allowed: false,
        reason: `A sua conta encontra-se no estado [${actingUser.status}]. Operações de pagamento bloqueadas.`
      };
    }

    if (actingUser.status === USER_STATUSES.DEACTIVATED) {
      return { allowed: false, reason: 'Esta conta encontra-se desativada.' };
    }

    return { allowed: true };
  }

  /**
   * Valida a integridade da estrutura de um pedido de pagamento antes do encaminhamento ao prestador.
   *
   * @param {object} paymentData
   * @returns {{ valid: boolean, reason?: string }}
   */
  validatePaymentRequestData(paymentData) {
    if (!paymentData) {
      return { valid: false, reason: 'Dados do pagamento não fornecidos.' };
    }

    const providerUpper = paymentData.provider ? paymentData.provider.toUpperCase() : '';
    if (!SUPPORTED_PROVIDERS.has(providerUpper)) {
      return {
        valid: false,
        reason: `Prestador de pagamento [${paymentData.provider}] não suportado. Prestadores aceites: ${Array.from(SUPPORTED_PROVIDERS).join(', ')}.`
      };
    }

    // Valida se o prestador está habilitado nas configurações de ambiente
    const providerKeyMap = {
      MULTICAIXA_EXPRESS: 'multicaixaExpress',
      UNITEL_MONEY: 'unitelMoney',
      E_KWANZA: 'eKwanza'
    };
    const providerConfigKey = providerKeyMap[providerUpper];
    const providerSettings = paymentsConfig.providers[providerConfigKey];

    if (!providerSettings || !providerSettings.enabled) {
      return {
        valid: false,
        reason: `O prestador [${providerUpper}] encontra-se temporariamente desativado ou indisponível.`
      };
    }

    const amount = BigInt(paymentData.amount || 0);
    if (amount <= 0n) {
      return { valid: false, reason: 'O montante de pagamento deve ser estritamente superior a zero.' };
    }

    const channelUpper = paymentData.channel ? paymentData.channel.toUpperCase() : 'MOBILE';
    if (!SUPPORTED_CHANNELS.has(channelUpper)) {
      return {
        valid: false,
        reason: `Canal de pagamento [${paymentData.channel}] inválido. Canais aceites: ${Array.from(SUPPORTED_CHANNELS).join(', ')}.`
      };
    }

    return { valid: true };
  }

  /**
   * Avalia se o utilizador atuante possui autorização para consultar os dados de uma ordem de pagamento (Anti-IDOR).
   * O próprio pagador titular da ordem ou agentes com papéis de auditoria financeira possuem acesso legítimo.
   *
   * @param {object} actingUser
   * @param {object} paymentRequest - Registo da tabela payment_requests
   * @returns {boolean}
   */
  canViewPaymentRequest(actingUser, paymentRequest) {
    if (!actingUser || !paymentRequest) {
      return false;
    }

    if (PAYMENT_AUDIT_ROLES.has(actingUser.role)) {
      return true;
    }

    return actingUser.id === paymentRequest.user_id;
  }

  /**
   * Avalia se uma ordem de pagamento pode ser cancelada antes de ser liquidada.
   *
   * @param {object} actingUser
   * @param {object} paymentRequest
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canCancelPaymentRequest(actingUser, paymentRequest) {
    if (!this.canViewPaymentRequest(actingUser, paymentRequest)) {
      return { allowed: false, reason: 'Acesso não autorizado a este pedido de pagamento.' };
    }

    if (paymentRequest.status !== PAYMENT_REQUEST_STATUSES.PENDING) {
      return {
        allowed: false,
        reason: `Pedidos com o estado [${paymentRequest.status}] não podem ser cancelados.`
      };
    }

    return { allowed: true };
  }
}

// Instância singleton da política de pagamentos
const paymentsPolicy = new PaymentsPolicy();

module.exports = paymentsPolicy;