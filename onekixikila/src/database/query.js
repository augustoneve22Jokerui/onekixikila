const { pool } = require('./pool');

// Limiar de tempo para alerta de consulta lenta (milissegundos)
const SLOW_QUERY_THRESHOLD_MS = 500;

// Padrões que NUNCA devem aparecer em mensagens de erro propagadas.
// A sanitização remove credenciais, hosts internos e parâmetros de ligação.
const SENSITIVE_PATTERNS = [
  /password[^\s]*/gi,
  /pwd[^\s]*/gi,
  /sslmode=[^\s&]+/gi,
  /postgres(ql)?:\/\/[^\s]+/gi,
  /host=[^\s&]+/gi,
  /user=[^\s&]+/gi,
  /database=[^\s&]+/gi
];

/**
 * Higieniza o texto de erro da base de dados para evitar vazamento de credenciais ou metadados de ligação.
 * Preserva `stack`, `code`, `detail`, `table` e `constraint` para diagnóstico.
 *
 * @param {Error} error
 * @returns {Error}
 */
const sanitizeDbError = (error) => {
  let safeMessage = String(error.message || 'Erro de base de dados.');

  for (const pattern of SENSITIVE_PATTERNS) {
    safeMessage = safeMessage.replace(pattern, '[REDACTED]');
  }

  const sanitized = new Error(safeMessage);
  sanitized.name = error.name || 'DatabaseError';
  sanitized.code = error.code;
  sanitized.detail = error.detail;
  sanitized.table = error.table;
  sanitized.constraint = error.constraint;

  // Preserva o stack ORIGINAL — aponta para a origem real do erro,
  // não para esta função de sanitização. Essencial para diagnóstico.
  if (error.stack) {
    sanitized.stack = error.stack;
  }

  return sanitized;
};

/**
 * Valida se o texto SQL é uma string não vazia.
 * @param {unknown} text
 * @param {string} caller
 */
const assertValidSqlText = (text, caller) => {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new TypeError(`[${caller}] O texto SQL deve ser uma string não vazia.`);
  }
};

/**
 * Executa uma consulta SQL parametrizada no pool do Neon PostgreSQL.
 *
 * @param {string} text - Consulta SQL parametrizada (ex: SELECT * FROM users WHERE id = $1)
 * @param {Array<any>} [params=[]] - Parâmetros da consulta
 * @returns {Promise<{ rows: Array<any>, rowCount: number|null, command: string }>}
 */
const query = async (text, params = []) => {
  assertValidSqlText(text, 'DATABASE:QUERY');

  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;

    if (duration > SLOW_QUERY_THRESHOLD_MS) {
      console.warn(
        `[DATABASE:QUERY:SLOW] Consulta executada em ${duration}ms: ${text.slice(0, 120)}...`
      );
    }

    return {
      rows: result.rows || [],
      // Preserva null (comando sem contagem de linhas) — o chamador decide o que fazer.
      // Transformar null em 0 esconderia erros lógicos (ex: lock optimista a passar
      // quando devia falhar).
      rowCount: typeof result.rowCount === 'number' ? result.rowCount : null,
      command: result.command || null
    };
  } catch (error) {
    console.error(`[DATABASE:QUERY:ERROR] Código [${error.code || 'N/A'}]: ${error.message}`);
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
 * @returns {Promise<{ rows: Array<any>, rowCount: number|null, command: string }>}
 */
const queryClient = async (client, text, params = []) => {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError(
      '[DATABASE:QUERY_CLIENT] Cliente transacional inválido: esperado um PoolClient com método query().'
    );
  }

  assertValidSqlText(text, 'DATABASE:QUERY_CLIENT');

  const start = Date.now();
  try {
    const result = await client.query(text, params);
    const duration = Date.now() - start;

    if (duration > SLOW_QUERY_THRESHOLD_MS) {
      console.warn(
        `[DATABASE:QUERY_CLIENT:SLOW] Consulta transacional em ${duration}ms: ${text.slice(0, 120)}...`
      );
    }

    return {
      rows: result.rows || [],
      rowCount: typeof result.rowCount === 'number' ? result.rowCount : null,
      command: result.command || null
    };
  } catch (error) {
    console.error(
      `[DATABASE:QUERY_CLIENT:ERROR] Código [${error.code || 'N/A'}]: ${error.message}`
    );
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
 * Assume que `text` é um SELECT. Se for um UPDATE/DELETE, devolve true se
 * afetou linhas — comportamento intencional, mas evite usar em comandos de escrita.
 *
 * @param {string} text
 * @param {Array<any>} [params=[]]
 * @param {import('pg').PoolClient} [client] - Opcional. Caso informado, executa na transação.
 * @returns {Promise<boolean>}
 */
const exists = async (text, params = [], client = null) => {
  const result = client
    ? await queryClient(client, text, params)
    : await query(text, params);

  // Se rowCount for null (comando sem contagem de linhas), usa rows como fallback.
  if (typeof result.rowCount === 'number') {
    return result.rowCount > 0;
  }
  return Array.isArray(result.rows) && result.rows.length > 0;
};

module.exports = {
  query,
  queryOne,
  queryClient,
  queryOneClient,
  exists
};