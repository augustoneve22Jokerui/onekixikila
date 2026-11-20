const env = require('./env');

const isProduction = env.NODE_ENV === 'production';
const isDevelopment = env.NODE_ENV === 'development';
const isTest = env.NODE_ENV === 'test';

const appConfig = Object.freeze({
  name: env.APP_NAME,
  env: env.NODE_ENV,
  isProduction,
  isDevelopment,
  isTest,
  port: env.PORT,
  baseUrl: env.APP_BASE_URL,
  apiPrefix: '/api/v1',
  currency: {
    code: env.DEFAULT_CURRENCY,
    symbol: 'Kz',
    locale: 'pt-AO',
    minorUnitsRatio: 1 // Kwanza opera em unidades inteiras na plataforma
  },
  server: {
    requestTimeoutMs: 30000,
    headersTimeoutMs: 35000,
    keepAliveTimeoutMs: 65000,
    shutdownTimeoutMs: 10000
  },
  session: {
    name: 'onekixikila.sid',
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'strict' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias
      path: '/'
    }
  },
  pagination: {
    defaultLimit: 20,
    maxLimit: 100
  }
});

module.exports = appConfig;