// =============================================================================
// config/database.js
// =============================================================================

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
  // Impede que queries individuais fiquem penduradas em caso de problema na BD.
  statement_timeout: 10000,
  query_timeout: 10000,
  // Mantém o socket TCP vivo entre pedidos — evita renegociação TLS
  // em cada query, que é a principal causa da latência observada (~2.2s).
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  // Neon recomenda reciclar conexões a cada 30 minutos para evitar
  // conexões envelhecidas que degradam a performance.
  maxLifetimeSeconds: 1800,
  application_name: 'onekixikila_core'
});

module.exports = databaseConfig;