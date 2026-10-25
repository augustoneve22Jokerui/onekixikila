const env = require('./env');
const appConfig = require('./app');

const notificationsConfig = Object.freeze({
  channels: {
    inApp: {
      enabled: true,
      retentionDays: 90,
      unreadLimit: 100
    },

    email: {
      enabled: Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS),
      host: env.SMTP_HOST || null,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: {
        user: env.SMTP_USER || null,
        pass: env.SMTP_PASS || null
      },
      from: env.SMTP_FROM,
      connectionTimeoutMs: 10000,
      socketTimeoutMs: 15000
    },

    sms: {
      enabled: Boolean(env.SMS_GATEWAY_URL && env.SMS_API_KEY),
      gatewayUrl: env.SMS_GATEWAY_URL || null,
      apiKey: env.SMS_API_KEY || null,
      senderId: env.SMS_SENDER_ID,
      defaultCountryCode: '+244', // Angola
      // Padrão de validação de número móvel em Angola: 9 dígitos iniciados por 9
      phoneRegex: /^(?:\+244|244)?(9[1-9]\d{7})$/,
      timeoutMs: 8000
    }
  },

  // Categorias de eventos e canais preferenciais por prioridade
  eventRouting: {
    ACCOUNT_VERIFICATION: ['sms', 'email'],
    PASSWORD_RESET: ['sms', 'email'],
    LOGIN_ALERT: ['email', 'inApp'],
    IDENTITY_REVIEW_RESULT: ['inApp', 'sms', 'email'],
    CONTRIBUTION_DUE_ALERT: ['inApp', 'sms'],
    PAYMENT_CONFIRMED: ['inApp', 'sms'],
    PAYMENT_FAILED: ['inApp', 'sms'],
    GROUP_INVITATION: ['inApp', 'sms'],
    ROTATION_BENEFICIARY_TURN: ['inApp', 'sms'],
    CHAT_MESSAGE: ['inApp']
  },

  // Fila e rotinas de envio
  queue: {
    batchSize: 25,
    maxRetries: 3,
    retryBackoffMs: 5000
  }
});

module.exports = notificationsConfig;