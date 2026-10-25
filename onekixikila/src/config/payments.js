const env = require('./env');

const paymentsConfig = Object.freeze({
  defaultCurrency: 'AOA',

  // Janela de tolerância para verificação de timestamps de webhooks (em milissegundos)
  webhookTimestampToleranceMs: 300000, // 5 minutos

  // Políticas de novas tentativas e tolerância para pedidos aos gateways
  httpTimeoutMs: 15000,
  maxRetryAttempts: 3,
  retryDelayMs: 1000,

  // Configuração individual dos prestadores integrados
  providers: {
    multicaixaExpress: {
      id: 'multicaixa_express',
      name: 'Multicaixa Express',
      apiUrl: env.MULTICAIXA_EXPRESS_API_URL || null,
      clientId: env.MULTICAIXA_EXPRESS_CLIENT_ID || null,
      clientSecret: env.MULTICAIXA_EXPRESS_CLIENT_SECRET || null,
      webhookSecret: env.MULTICAIXA_EXPRESS_WEBHOOK_SECRET || null,
      enabled: Boolean(
        env.MULTICAIXA_EXPRESS_API_URL &&
        env.MULTICAIXA_EXPRESS_CLIENT_ID &&
        env.MULTICAIXA_EXPRESS_CLIENT_SECRET
      ),
      supportedChannels: ['MOBILE_APP', 'CARD', 'QR_CODE']
    },

    unitelMoney: {
      id: 'unitel_money',
      name: 'Unitel Money',
      apiUrl: env.UNITEL_MONEY_API_URL || null,
      clientId: env.UNITEL_MONEY_CLIENT_ID || null,
      clientSecret: env.UNITEL_MONEY_CLIENT_SECRET || null,
      webhookSecret: env.UNITEL_MONEY_WEBHOOK_SECRET || null,
      enabled: Boolean(
        env.UNITEL_MONEY_API_URL &&
        env.UNITEL_MONEY_CLIENT_ID &&
        env.UNITEL_MONEY_CLIENT_SECRET
      ),
      supportedChannels: ['MOBILE_WALLET', 'USSD', 'QR_CODE']
    },

    eKwanza: {
      id: 'e_kwanza',
      name: 'e-Kwanza',
      apiUrl: env.E_KWANZA_API_URL || null,
      apiKey: env.E_KWANZA_API_KEY || null,
      webhookSecret: env.E_KWANZA_WEBHOOK_SECRET || null,
      enabled: Boolean(env.E_KWANZA_API_URL && env.E_KWANZA_API_KEY),
      supportedChannels: ['DIGITAL_ACCOUNT', 'QR_CODE']
    }
  },

  // Parâmetros do motor de reconciliação periódica
  reconciliation: {
    batchSize: 50,
    intervalMinutes: 15,
    pendingPaymentMaxAgeHours: 24, // Limite para expirar intenções de pagamento pendentes
    autoExpireAbandonedPayments: true
  }
});

module.exports = paymentsConfig;