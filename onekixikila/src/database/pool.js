const { Pool } = require('pg');
const databaseConfig = require('../config/database');

// Criação da instância singleton do Pool de conexões do Neon PostgreSQL
const pool = new Pool(databaseConfig);

// Evento disparado quando um cliente é conectado ao pool
pool.on('connect', (client) => {
  // Padronização de sessão: fuso horário UTC e timezone consistente
  client.query("SET timezone = 'UTC';", (err) => {
    if (err) {
      console.error('[DATABASE:POOL] Falha ao configurar timezone da sessão:', err.message);
    }
  });
});

// Evento para capturar e conter falhas inesperadas em clientes ociosos
pool.on('error', (err) => {
  console.error('[DATABASE:POOL] Erro inesperado em cliente ocioso do PostgreSQL:', err.message);
});

/**
 * Retorna a instância ativa do pool.
 * @returns {import('pg').Pool}
 */
const getPool = () => pool;

/**
 * Executa uma verificação ativa de integridade da conexão com o Neon PostgreSQL.
 * @returns {Promise<{ status: string, latencyMs: number, serverTime: string }>}
 */
const testConnection = async () => {
  const start = Date.now();
  const result = await pool.query('SELECT NOW() AS server_time, version() AS pg_version;');
  const latencyMs = Date.now() - start;

  return {
    status: 'connected',
    latencyMs,
    serverTime: result.rows[0].server_time.toISOString()
  };
};

/**
 * Encerra o pool de conexões de forma graciosa durante o encerramento do processo.
 * @returns {Promise<void>}
 */
const closePool = async () => {
  try {
    await pool.end();
    console.log('[DATABASE:POOL] Conexões com Neon PostgreSQL encerradas com sucesso.');
  } catch (err) {
    console.error('[DATABASE:POOL] Erro ao encerrar conexões do pool:', err.message);
  }
};

module.exports = {
  pool,
  getPool,
  testConnection,
  closePool
};