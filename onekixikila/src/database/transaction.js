const { pool } = require('./pool');

/**
 * Níveis de isolamento de transação suportados pelo PostgreSQL.
 */
const ISOLATION_LEVELS = Object.freeze({
  READ_COMMITTED: 'READ COMMITTED',
  REPEATABLE_READ: 'REPEATABLE READ',
  SERIALIZABLE: 'SERIALIZABLE'
});

/**
 * Executa uma operação atómica dentro de uma transação SQL gerenciada.
 * Garante BEGIN, COMMIT e ROLLBACK automático em caso de exceção, libertando sempre o cliente para o pool.
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} callback - Função com a lógica de negócio transacional.
 * @param {object} [options] - Opções de configuração da transação.
 * @param {'READ COMMITTED'|'REPEATABLE READ'|'SERIALIZABLE'} [options.isolationLevel='READ COMMITTED'] - Nível de isolamento SQL.
 * @param {boolean} [options.readOnly=false] - Define se a transação é estritamente de leitura.
 * @returns {Promise<T>} Resultado retornado pelo callback.
 */
const withTransaction = async (callback, options = {}) => {
  const {
    isolationLevel = ISOLATION_LEVELS.READ_COMMITTED,
    readOnly = false
  } = options;

  const client = await pool.connect();

  try {
    const beginQuery = [
      'BEGIN TRANSACTION ISOLATION LEVEL',
      isolationLevel,
      readOnly ? 'READ ONLY' : 'READ WRITE'
    ].join(' ');

    await client.query(beginQuery);

    const result = await callback(client);

    await client.query('COMMIT;');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK;');
    } catch (rollbackError) {
      console.error('[DATABASE:TRANSACTION] Falha catastrófica ao executar ROLLBACK:', rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Inicia manualmente uma transação e devolve o cliente do pool.
 * Exige chamada manual de commit ou rollback e libertação obrigatória do cliente.
 *
 * @param {'READ COMMITTED'|'REPEATABLE READ'|'SERIALIZABLE'} [isolationLevel='READ COMMITTED']
 * @returns {Promise<import('pg').PoolClient>}
 */
const beginManualTransaction = async (isolationLevel = ISOLATION_LEVELS.READ_COMMITTED) => {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN TRANSACTION ISOLATION LEVEL ${isolationLevel};`);
    return client;
  } catch (err) {
    client.release();
    throw err;
  }
};

/**
 * Confirma a transação manual e liberta o cliente.
 * @param {import('pg').PoolClient} client
 * @returns {Promise<void>}
 */
const commitManualTransaction = async (client) => {
  try {
    await client.query('COMMIT;');
  } finally {
    client.release();
  }
};

/**
 * Reverte a transação manual e liberta o cliente.
 * @param {import('pg').PoolClient} client
 * @returns {Promise<void>}
 */
const rollbackManualTransaction = async (client) => {
  try {
    await client.query('ROLLBACK;');
  } finally {
    client.release();
  }
};

module.exports = {
  ISOLATION_LEVELS,
  withTransaction,
  beginManualTransaction,
  commitManualTransaction,
  rollbackManualTransaction
};