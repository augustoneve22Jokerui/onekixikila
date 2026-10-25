const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para a tabela `limits`.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para gestão da matriz de limites
 * operacionais por nível KYC (Tiers), escopos temporais (diário, mensal, transação) e
 * apuração do volume financeiro acumulado por utilizador.
 */
class LimitsRepository {
  /**
   * Insere ou atualiza um limite operacional na tabela limits.
   *
   * @param {object} params
   * @param {string} params.tierCode - 'TIER_1_UNVERIFIED', 'TIER_2_VERIFIED', 'TIER_3_ENHANCED'
   * @param {string} params.operationType - 'DEPOSIT', 'WITHDRAWAL', 'INTERNAL_TRANSFER', etc.
   * @param {string} params.scope - 'PER_TRANSACTION', 'DAILY', 'MONTHLY'
   * @param {number|bigint} params.maxAmount - Valor teto em Kwanzas (AOA)
   * @param {number|null} [params.maxCount=null] - Quantidade máxima de transações
   * @param {string} [params.currency='AOA']
   * @param {boolean} [params.isActive=true]
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async upsertLimit(params, client = null) {
    const {
      tierCode,
      operationType,
      scope,
      maxAmount,
      maxCount = null,
      currency = 'AOA',
      isActive = true
    } = params;

    const text = `
      INSERT INTO limits (
        tier_code,
        operation_type,
        scope,
        max_amount,
        max_count,
        currency,
        is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tier_code, operation_type, scope)
      DO UPDATE SET
        max_amount = EXCLUDED.max_amount,
        max_count = EXCLUDED.max_count,
        currency = EXCLUDED.currency,
        is_active = EXCLUDED.is_active,
        updated_at = NOW() AT TIME ZONE 'UTC'
      RETURNING *;
    `;

    const values = [
      tierCode,
      operationType.toUpperCase(),
      scope.toUpperCase(),
      maxAmount,
      maxCount,
      currency,
      isActive
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza a regra de limite aplicável para determinado nível de KYC, operação e escopo.
   *
   * @param {string} tierCode
   * @param {string} operationType
   * @param {string} scope
   * @param {import('pg').PoolClient} [client]
   */
  async findLimitRule(tierCode, operationType, scope, client = null) {
    const text = `
      SELECT 
        id,
        tier_code,
        operation_type,
        scope,
        max_amount,
        max_count,
        currency,
        is_active,
        created_at,
        updated_at
      FROM limits
      WHERE tier_code = $1
        AND operation_type = $2
        AND scope = $3
        AND is_active = TRUE;
    `;

    const values = [tierCode, operationType.toUpperCase(), scope.toUpperCase()];
    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Lista todas as regras de limites cadastradas para determinado nível de verificação (KYC Tier).
   *
   * @param {string} tierCode
   * @param {import('pg').PoolClient} [client]
   */
  async listLimitsByTier(tierCode, client = null) {
    const text = `
      SELECT 
        id,
        tier_code,
        operation_type,
        scope,
        max_amount,
        max_count,
        currency,
        is_active
      FROM limits
      WHERE tier_code = $1
      ORDER BY operation_type ASC, scope ASC;
    `;

    const result = client ? await queryClient(client, text, [tierCode]) : await query(text, [tierCode]);
    return result.rows;
  }

  /**
   * Lista a matriz completa de limites operacionais de todos os níveis da plataforma.
   *
   * @param {import('pg').PoolClient} [client]
   */
  async listAllLimits(client = null) {
    const text = `
      SELECT 
        id,
        tier_code,
        operation_type,
        scope,
        max_amount,
        max_count,
        currency,
        is_active,
        created_at,
        updated_at
      FROM limits
      ORDER BY tier_code ASC, operation_type ASC, scope ASC;
    `;

    const result = client ? await queryClient(client, text) : await query(text);
    return result.rows;
  }

  /**
   * Apura o volume total acumulado e a contagem de transações de um utilizador em determinada operação
   * dentro de uma janela temporal (hoje em UTC ou mês atual em UTC) a partir das tabelas transacionais.
   *
   * @param {string} userId
   * @param {string} operationType - 'DEPOSIT', 'WITHDRAWAL', 'INTERNAL_TRANSFER'
   * @param {'DAILY'|'MONTHLY'} scope
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ consumedVolume: bigint, transactionCount: number }>}
   */
  async getUserConsumedVolume(userId, operationType, scope, client = null) {
    const intervalTrunc = scope === 'DAILY' ? 'day' : 'month';

    let tableName;
    let amountColumn = 'amount';
    let statusFilter = `status IN ('CONFIRMED', 'SETTLED', 'PROCESSING', 'PENDING_PAYMENT')`;
    let userColumn = 'user_id';

    if (operationType === 'DEPOSIT') {
      tableName = 'deposits';
    } else if (operationType === 'WITHDRAWAL') {
      tableName = 'withdrawals';
      statusFilter = `status IN ('REQUESTED', 'APPROVED', 'PROCESSING', 'SETTLED')`;
    } else if (operationType === 'INTERNAL_TRANSFER') {
      tableName = 'internal_transfers';
      userColumn = 'sender_user_id';
      statusFilter = `status IN ('PENDING', 'COMPLETED')`;
    } else {
      return { consumedVolume: 0n, transactionCount: 0 };
    }

    const text = `
      SELECT 
        COALESCE(SUM(${amountColumn}), 0)::bigint AS consumed_volume,
        COUNT(*)::integer AS tx_count
      FROM ${tableName}
      WHERE ${userColumn} = $1
        AND ${statusFilter}
        AND created_at >= date_trunc('${intervalTrunc}', NOW() AT TIME ZONE 'UTC');
    `;

    const result = client ? await queryOneClient(client, text, [userId]) : await queryOne(text, [userId]);

    return {
      consumedVolume: result ? BigInt(result.consumed_volume) : 0n,
      transactionCount: result ? Number(result.tx_count) : 0
    };
  }
}

// Instância singleton do repositório de limites
const limitsRepository = new LimitsRepository();

module.exports = limitsRepository;