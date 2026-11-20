const crypto = require('crypto');
const ValidationError = require('../errors/validation-error');
const ConflictError = require('../errors/conflict-error');

// Expressão regular para validação do formato canónico de chaves de idempotência (entre 8 e 120 caracteres)
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_\-:]{8,120}$/;

/**
 * Utilitário especializado em gestão e validação de chaves de idempotência para o motor financeiro
 * da plataforma OneKixikila.
 *
 * Garante processamento "exactly-once" (exatamente uma vez) em mutações de saldo, cobranças de quotas,
 * liquidações de carteira e débitos bancários, prevenindo duplicações causadas por reenvios de rede ou concorrência.
 */
class FinancialIdempotency {
  /**
   * Valida rigorosamente a formatação e as restrições de uma chave de idempotência.
   *
   * @param {string} key - Chave de idempotência submetida
   * @returns {string} Chave validada e normalizada
   */
  validateKey(key) {
    if (!key || typeof key !== 'string') {
      throw ValidationError.fieldRequired('idempotencyKey');
    }

    const trimmedKey = key.trim();

    if (!IDEMPOTENCY_KEY_REGEX.test(trimmedKey)) {
      throw ValidationError.invalidFormat(
        'idempotencyKey',
        'Cadeia alfanumérica contendo hífens, underscores ou dois-pontos com tamanho entre 8 e 120 caracteres'
      );
    }

    return trimmedKey;
  }

  /**
   * Gera uma chave de idempotência determinística e única para uma operação financeira.
   *
   * @param {string} operationType - Tipo da operação (ex: 'DEPOSIT', 'CONTRIBUTION', 'TRANSFER', 'WITHDRAWAL')
   * @param {string} entityId - Identificador único de entidade relacionada (ex: user_id, obligation_id)
   * @param {string|number} [discriminator] - Discriminador opcional de ciclo, rodada ou referência
   * @returns {string} Chave estruturada com no máximo 120 caracteres
   */
  generateKey(operationType, entityId, discriminator = '') {
    if (!operationType || !entityId) {
      throw new Error('Tipo de operação e identificador de entidade são obrigatórios para gerar chave de idempotência.');
    }

    const cleanOp = operationType.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const cleanEntity = String(entityId).trim().replace(/[^A-Za-z0-9_-]/g, '');
    const cleanDisc = discriminator ? `-${String(discriminator).trim().replace(/[^A-Za-z0-9_-]/g, '')}` : '';
    const uniqueSuffix = crypto.randomBytes(6).toString('hex');

    const generated = `${cleanOp}-${cleanEntity}${cleanDisc}-${uniqueSuffix}`;
    return generated.slice(0, 120);
  }

  /**
   * Calcula a assinatura digital (hash SHA-256) dos dados semânticos da transação.
   * Assegura que repetições com a mesma chave possuam rigorosamente os mesmos parâmetros financeiros
   * (montante, moeda, remetente, destinatário), rejeitando adulterações ou colisões indevidas.
   *
   * @param {object} payload - Parâmetros financeiros da transação
   * @returns {string} Digest SHA-256 de 64 caracteres hexadecimais
   */
  calculatePayloadHash(payload) {
    if (payload === null || payload === undefined) {
      return crypto.createHash('sha256').update('', 'utf8').digest('hex');
    }

    // Ordena chaves de primeiro nível para garantir serialização determinística e invariante
    const sortedKeys = Object.keys(payload).sort();
    const normalizedObject = {};

    for (const k of sortedKeys) {
      const val = payload[k];
      normalizedObject[k] = typeof val === 'bigint' ? val.toString() : val;
    }

    const serialized = JSON.stringify(normalizedObject);
    return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
  }

  /**
   * Valida a correspondência entre o hash previamente registrado e o novo payload submetido.
   * Dispara ConflictError caso uma chave conhecida seja reutilizada com valores distintos.
   *
   * @param {string} existingHash - Hash previamente gravado na base de dados
   * @param {string} currentHash - Hash calculado do payload recebido
   */
  verifyPayloadConsistency(existingHash, currentHash) {
    if (!existingHash || !currentHash) {
      return;
    }

    if (existingHash !== currentHash) {
      throw new ConflictError(
        'Colisão de chave de idempotência: Esta chave já foi processada anteriormente com parâmetros e montantes divergentes.',
        'IDEMPOTENCY_PAYLOAD_MISMATCH'
      );
    }
  }

  /**
   * Executa a verificação transacional de idempotência no contexto de uma transação SQL.
   * Verifica se a chave informada já foi consumida em determinada tabela financeira.
   *
   * @param {import('pg').PoolClient} client - Conexão transacional ativa
   * @param {string} tableName - Nome da tabela com coluna idempotency_key (ex: 'contributions', 'deposits', 'withdrawals')
   * @param {string} idempotencyKey - Chave de idempotência a verificar
   * @returns {Promise<any|null>} Registro existente ou null se inédito
   */
  async findExistingTransaction(client, tableName, idempotencyKey) {
    const validTables = new Set([
      'contributions',
      'deposits',
      'withdrawals',
      'internal_transfers',
      'ledger_transactions'
    ]);

    if (!validTables.has(tableName)) {
      throw new Error(`Tabela financeira [${tableName}] não autorizada para verificação de idempotência.`);
    }

    const queryText = `
      SELECT id, idempotency_key, status, created_at
      FROM ${tableName}
      WHERE idempotency_key = $1
      LIMIT 1;
    `;

    const result = await client.query(queryText, [idempotencyKey]);
    return result.rows.length > 0 ? result.rows[0] : null;
  }
}

// Instância singleton do serviço de idempotência financeira
const financialIdempotency = new FinancialIdempotency();

module.exports = financialIdempotency;