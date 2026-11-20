const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para o Livro-Razão (Ledger) em Partidas Dobradas.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para gestão do plano de contas,
 * inserção atómica de transações e lançamentos de débito/crédito, apuração de balancetes
 * e atualização auditada de saldos contábeis.
 */
class LedgerRepository {
  /**
   * Localiza uma conta do livro-razão pelo seu código estruturado único (ex: '1001-SETTLEMENT-POOL').
   *
   * @param {string} accountCode
   * @param {import('pg').PoolClient} [client]
   */
  async findAccountByCode(accountCode, client = null) {
    const text = `
      SELECT 
        id,
        account_code,
        name,
        account_type,
        currency,
        is_system,
        user_id,
        wallet_id,
        balance,
        created_at,
        updated_at
      FROM ledger_accounts
      WHERE account_code = $1;
    `;

    return client ? queryOneClient(client, text, [accountCode]) : queryOne(text, [accountCode]);
  }

  /**
   * Localiza a conta de passivo exigível vinculada a um utilizador e respetiva carteira.
   *
   * @param {string} userId
   * @param {string} walletId
   * @param {import('pg').PoolClient} [client]
   */
  async findUserAccount(userId, walletId, client = null) {
    const text = `
      SELECT 
        id,
        account_code,
        name,
        account_type,
        currency,
        is_system,
        user_id,
        wallet_id,
        balance
      FROM ledger_accounts
      WHERE user_id = $1 AND wallet_id = $2;
    `;

    return client ? queryOneClient(client, text, [userId, walletId]) : queryOne(text, [userId, walletId]);
  }

  /**
   * Insere o cabeçalho de uma transação contábil na tabela ledger_transactions.
   *
   * @param {object} params
   * @param {string} params.referenceCode - Código de referência único da transação
   * @param {string} params.idempotencyKey - Chave única de idempotência
   * @param {string} params.operationType - Tipo da operação financeira
   * @param {string} [params.status='POSTED'] - 'POSTED', 'PENDING', etc.
   * @param {number|bigint} params.amount - Montante total equilibrado em Kwanzas
   * @param {string} [params.currency='AOA']
   * @param {string} params.description
   * @param {object} [params.metadata={}]
   * @param {string|null} [params.relatedTransactionId] - Transação original em caso de estorno
   * @param {import('pg').PoolClient} client - Cliente transacional obrigatório
   * @returns {Promise<object>}
   */
  async createTransactionHeader(params, client) {
    const {
      referenceCode,
      idempotencyKey,
      operationType,
      status = 'POSTED',
      amount,
      currency = 'AOA',
      description,
      metadata = {},
      relatedTransactionId = null
    } = params;

    const text = `
      INSERT INTO ledger_transactions (
        reference_code,
        idempotency_key,
        operation_type,
        status,
        amount,
        currency,
        description,
        metadata,
        related_transaction_id,
        posted_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, NOW() AT TIME ZONE 'UTC')
      RETURNING *;
    `;

    const values = [
      referenceCode,
      idempotencyKey,
      operationType,
      status,
      amount,
      currency,
      description,
      JSON.stringify(metadata),
      relatedTransactionId
    ];

    return queryOneClient(client, text, values);
  }

  /**
   * Insere em lote as pernas de débito e crédito na tabela ledger_entries.
   *
   * @param {Array<{ transactionId: string, accountId: string, direction: 'DEBIT'|'CREDIT', amount: number|bigint, sequence: number }>} entries
   * @param {import('pg').PoolClient} client
   */
  async createEntriesBatch(entries, client) {
    if (!entries || entries.length === 0) {
      return [];
    }

    const valueClauses = [];
    const values = [];
    let paramIndex = 1;

    for (const e of entries) {
      valueClauses.push(
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, 'AOA', $${paramIndex + 4})`
      );
      values.push(e.transactionId, e.accountId, e.direction, e.amount, e.sequence);
      paramIndex += 5;
    }

    const text = `
      INSERT INTO ledger_entries (
        transaction_id,
        account_id,
        direction,
        amount,
        currency,
        sequence
      )
      VALUES ${valueClauses.join(', ')}
      RETURNING *;
    `;

    const result = await queryClient(client, text, values);
    return result.rows;
  }

  /**
   * Atualiza o saldo acumulado de uma conta do livro-razão no banco de dados.
   *
   * @param {string} accountId
   * @param {number|bigint} deltaAmount - Valor a somar (positivo) ou subtrair (negativo)
   * @param {import('pg').PoolClient} client
   */
  async updateAccountBalance(accountId, deltaAmount, client) {
    const text = `
      UPDATE ledger_accounts
      SET balance = balance + $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2
      RETURNING id, account_code, balance;
    `;

    return queryOneClient(client, text, [deltaAmount, accountId]);
  }

  /**
   * Localiza uma transação contábil pelo seu identificador primário UUID, unindo as suas pernas em partidas dobradas.
   *
   * @param {string} transactionId
   * @param {import('pg').PoolClient} [client]
   */
  async findTransactionById(transactionId, client = null) {
    const text = `
      SELECT 
        lt.id,
        lt.reference_code,
        lt.idempotency_key,
        lt.operation_type,
        lt.status,
        lt.amount,
        lt.currency,
        lt.description,
        lt.metadata,
        lt.related_transaction_id,
        lt.posted_at,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'entryId', le.id,
              'accountId', le.account_id,
              'accountCode', la.account_code,
              'accountName', la.name,
              'direction', le.direction,
              'amount', le.amount,
              'sequence', le.sequence
            ) ORDER BY le.sequence ASC
          ),
          '[]'::jsonb
        ) AS entries
      FROM ledger_transactions lt
      LEFT JOIN ledger_entries le ON le.transaction_id = lt.id
      LEFT JOIN ledger_accounts la ON la.id = le.account_id
      WHERE lt.id = $1
      GROUP BY lt.id;
    `;

    return client ? queryOneClient(client, text, [transactionId]) : queryOne(text, [transactionId]);
  }

  /**
   * Consulta o extrato de lançamentos de uma conta específica do livro-razão com paginação.
   *
   * @param {string} accountId
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async getAccountStatement(accountId, pagination = { limit: 20, offset: 0 }, client = null) {
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM ledger_entries
      WHERE account_id = $1;
    `;
    const countResult = client ? await queryOneClient(client, countSql, [accountId]) : await queryOne(countSql, [accountId]);
    const totalCount = countResult ? countResult.total : 0;

    const dataSql = `
      SELECT 
        le.id AS entry_id,
        le.direction,
        le.amount,
        le.currency,
        le.sequence,
        le.created_at,
        lt.id AS transaction_id,
        lt.reference_code,
        lt.operation_type,
        lt.description,
        lt.posted_at
      FROM ledger_entries le
      INNER JOIN ledger_transactions lt ON lt.id = le.transaction_id
      WHERE le.account_id = $1
      ORDER BY le.created_at DESC, le.sequence ASC
      LIMIT $2 OFFSET $3;
    `;

    const dataResult = client
      ? await queryClient(client, dataSql, [accountId, pagination.limit, pagination.offset])
      : await query(dataSql, [accountId, pagination.limit, pagination.offset]);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }

  /**
   * Realiza a verificação global de integridade do razão, confrontando a soma de todos os débitos
   * com a soma de todos os créditos de todas as transações confirmadas ('POSTED').
   *
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ totalDebits: bigint, totalCredits: bigint, discrepancyCount: number }>}
   */
  async auditDoubleEntryIntegrity(client = null) {
    const text = `
      SELECT 
        COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0)::bigint AS total_debits,
        COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0)::bigint AS total_credits,
        (
          SELECT COUNT(*)::integer
          FROM (
            SELECT 
              transaction_id,
              SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) AS debits,
              SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END) AS credits
            FROM ledger_entries
            GROUP BY transaction_id
            HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END) <> SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END)
          ) unbalanced_txs
        ) AS discrepancy_count
      FROM ledger_entries;
    `;

    const result = client ? await queryOneClient(client, text) : await queryOne(text);

    return {
      totalDebits: result ? BigInt(result.total_debits) : 0n,
      totalCredits: result ? BigInt(result.total_credits) : 0n,
      discrepancyCount: result ? Number(result.discrepancy_count) : 0
    };
  }
}

// Instância singleton do repositório do livro-razão
const ledgerRepository = new LedgerRepository();

module.exports = ledgerRepository;