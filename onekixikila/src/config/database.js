const env = require('./env');

const databaseConfig = Object.freeze({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL
    ? {
        rejectUnauthorized: false
      }
    : false,
  max: env.DATABASE_MAX_CONNECTIONS,
  idleTimeoutMillis: env.DATABASE_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT_MS,
  statement_timeout: 15000,
  query_timeout: 15000,
  application_name: 'onekixikila_core'
});

module.exports = databaseConfig;