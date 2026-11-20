const MulticaixaExpressProvider = require('./multicaixa-express.provider');
const UnitelMoneyProvider = require('./unitel-money.provider');
const EKwanzaProvider = require('./e-kwanza.provider');
const paymentsConfig = require('../../config/payments');

/**
 * Normaliza os identificadores de prestadores para chaves canónicas da plataforma.
 * @param {string} providerName
 * @returns {string}
 */
const normalizeProviderKey = (providerName) => {
  if (!providerName || typeof providerName !== 'string') {
    return '';
  }
  return providerName.trim().toLowerCase().replace(/[- ]/g, '_');
};

/**
 * Fábrica (Factory) para instanciação, cache e resolução de prestadores de pagamento angolanos.
 */
class PaymentProviderFactory {
  constructor() {
    this.instances = new Map();
  }

  /**
   * Retorna a instância singleton do prestador de pagamento solicitado.
   *
   * @param {string} providerKey - 'MULTICAIXA_EXPRESS', 'UNITEL_MONEY' ou 'E_KWANZA' (ou minúsculas)
   * @returns {import('../contracts/payment-provider.contract')}
   */
  getProvider(providerKey) {
    const normalized = normalizeProviderKey(providerKey);

    if (this.instances.has(normalized)) {
      return this.instances.get(normalized);
    }

    let providerInstance;

    switch (normalized) {
      case 'multicaixa_express':
      case 'multicaixa':
      case 'mcx':
        providerInstance = new MulticaixaExpressProvider();
        break;

      case 'unitel_money':
      case 'unitel':
        providerInstance = new UnitelMoneyProvider();
        break;

      case 'e_kwanza':
      case 'ekwanza':
        providerInstance = new EKwanzaProvider();
        break;

      default:
        throw new Error(
          `[PAYMENT_FACTORY] Prestador de pagamento [${providerKey}] não é suportado pelo OneKixikila.`
        );
    }

    this.instances.set(normalized, providerInstance);
    return providerInstance;
  }

  /**
   * Retorna os metadados dos prestadores que possuem credenciais e estão ativos no sistema.
   * @returns {Array<{ id: string, name: string, enabled: boolean, channels: string[] }>}
   */
  listAvailableProviders() {
    return Object.values(paymentsConfig.providers).map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      channels: p.supportedChannels
    }));
  }

  /**
   * Sugere o prestador mais adequado com base no canal pretendido ou operadora móvel angolana.
   *
   * @param {string} [phoneNumber] - Número de telemóvel do utilizador (+244...)
   * @param {string} [preferredChannel='MOBILE_APP']
   * @returns {string} Código do prestador recomendado
   */
  resolveDefaultProvider(phoneNumber, preferredChannel = 'MOBILE_APP') {
    // Se o utilizador tiver número Unitel e preferir carteira móvel
    if (phoneNumber && /^(?:\+244|244)?(92\d|93\d|94\d)/.test(phoneNumber)) {
      if (paymentsConfig.providers.unitelMoney.enabled) {
        return 'unitel_money';
      }
    }

    // Padrão nacional preferencial interbancário
    return 'multicaixa_express';
  }
}

// Instância singleton da fábrica de prestadores
const providerFactory = new PaymentProviderFactory();

module.exports = providerFactory;