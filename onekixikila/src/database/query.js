const { pool } = require('./pool');

// Limiar de tempo para alerta de consulta lenta (milissegundos)
const SLOW_QUERY_THRESHOLD_MS = 500;

/**
 * Higieniza o texto de erro da base de dados para evitar vazamento de credenciais ou metadados de ligação.
 * @param {Error} error
 * @returns {Error}
 */
const sanitizeDbError = (error) => {
  const sanitized = new Error(error.message);
  sanitized.code = error.code;
  sanitized.detail = error.detail;
  sanitized.table = error.table;
  sanitized.constraint = error.constraint;
  return sanitized;
};

/**
 * Executa uma consulta SQL parametrizada no pool do Neon PostgreSQL.
 *
 * @param {string} text - Consulta SQL parametrizada (ex: SELECT * FROM users WHERE id = $1)
 * @param {Array<any>} [params=[]] - Parâmetros da consulta
 * @returns {Promise<{ rows: Array<any>, rowCount: number, command: string }>}
 */
const query = async (text, params = []) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;

    if (duration > SLOW_QUERY_THRESHOLD_MS) {
      console.warn(`[DATABASE:QUERY:SLOW] Consulta executada em ${duration}ms: ${text.slice(0, 120)}...`);
    }

    return {
      rows: result.rows,
      rowCount: result.rowCount || 0,
      command: result.command
    };
  } catch (error) {
    console.error(`[DATABASE:QUERY:ERROR] Código [${error.code}]: ${error.message}`);
    throw sanitizeDbError(error);
  }
};

/**
 * Executa uma consulta e devolve exatamente a primeira linha encontrada ou null se vazia.
 *
 * @param {string} text
 * @param {Array<any>} [params=[]]
 * @returns {Promise<any | null>}
 */
const queryOne = async (text, params = []) => {
  const result = await query(text, params);
  return result.rows.length > 0 ? result.rows[0] : null;
};

/**
 * Executa uma consulta SQL parametrizada utilizando um cliente de transação específico.
 *
 * @param {import('pg').PoolClient} client - Cliente transacional obtido via withTransaction ou beginManualTransaction
 * @param {string} text
 * @param {Array<any>} [params=[]]
 * @returns {Promise<{ rows: Array<any>, rowCount: number, command: string }>}
 */
const queryClient = async (client, text, params = []) => {
  const start = Date.now();
  try {
    const result = await client.query(text, params);
    const duration = Date.now() - start;

    if (duration > SLOW_QUERY_THRESHOLD_MS) {
      console.warn(`[DATABASE:QUERY_CLIENT:SLOW] Consulta transacional em ${duration}ms: ${text.slice(0, 120)}...`);
    }

    return {
      rows: result.rows,
      rowCount: result.rowCount || 0,
      command: result.command
    };
  } catch (error) {
    console.error(`[DATABASE:QUERY_CLIENT:ERROR] Código [${error.code}]: ${error.message}`);
    throw sanitizeDbError(error);
  }
};

/**
 * Executa uma consulta transacional e devolve exatamente a primeira linha ou null.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} text
 * @param {Array<any>} [params=[]]
 * @returns {Promise<any | null>}
 */
const queryOneClient = async (client, text, params = []) => {
  const result = await queryClient(client, text, params);
  return result.rows.length > 0 ? result.rows[0] : null;
};

/**
 * Verifica se pelo menos um registo corresponde aos critérios informados.
 *
 * @param {string} text
 * @param {Array<any>} [params=[]]
 * @param {import('pg').PoolClient} [client] - Opcional. Caso informado, executa na transação.
 * @returns {Promise<boolean>}
 */
const exists = async (text, params = [], client = null) => {
  const executor = client ? queryClient(client, text, params) : query(text, params);
  const result = await executor;
  return result.rowCount > 0;
};

module.exports = {
  query,
  queryOne,
  queryClient,
  queryOneClient,
  exists
};