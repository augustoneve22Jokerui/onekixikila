const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para a tabela `wallets` e extratos do livro-razão.
 * Executa consultas diretas e parametrizadas no Neon PostgreSQL para controle dos saldos da carteira
 * (disponível, retido e contabilístico em AOA), integridade contábil, emissão de recibos e supervisão financeira.
 */
class WalletRepository {
  /**
   * Localiza a carteira digital vinculada a um utilizador específico.
   *
   * @param {string} userId - UUID do utilizador
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   */
  async findByUserId(userId, client = null) {
    const text = `
      SELECT 
        w.id,
        w.user_id,
        w.currency,
        w.status,
        w.ledger_balance,
        w.available_balance,
        w.locked_balance,
        w.created_at,
        w.updated_at
      FROM wallets w
      WHERE w.user_id = $1;
    `;

    return client ? queryOneClient(client, text, [userId]) : queryOne(text, [userId]);
  }

  /**
   * Localiza uma carteira digital pelo seu identificador primário UUID.
   *
   * @param {string} walletId
   * @param {import('pg').PoolClient} [client]
   */
  async findById(walletId, client = null) {
    const text = `
      SELECT 
        w.id,
        w.user_id,
        w.currency,
        w.status,
        w.ledger_balance,
        w.available_balance,
        w.locked_balance,
        w.created_at,
        w.updated_at
      FROM wallets w
      WHERE w.id = $1;
    `;

    return client ? queryOneClient(client, text, [walletId]) : queryOne(text, [walletId]);
  }

  /**
   * Atualiza o estado operacional da carteira (ex: ACTIVE -> FROZEN -> SUSPENDED).
   *
   * @param {string} walletId
   * @param {string} status - 'ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED'
   * @param {import('pg').PoolClient} [client]
   */
  async updateStatus(walletId, status, client = null) {
    const text = `
      UPDATE wallets
      SET status = $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2
      RETURNING id, user_id, status, updated_at;
    `;

    return client ? queryOneClient(client, text, [status, walletId]) : queryOne(text, [status, walletId]);
  }

  /**
   * Consulta o extrato consolidado de lançamentos contábeis associados à carteira do utilizador.
   * Faz a junção entre a conta pessoal da carteira no livro-razão (`ledger_accounts`),
   * os lançamentos em partidas dobradas (`ledger_entries`) e os cabeçalhos de transação (`ledger_transactions`).
   *
   * @param {string} walletId
   * @param {object} [filters={}] - { operationType, startDate, endDate }
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async getStatement(walletId, filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = ['la.wallet_id = $1'];
    const values = [walletId];
    let paramIndex = 2;

    if (filters.operationType) {
      conditions.push(`lt.operation_type = $${paramIndex}`);
      values.push(filters.operationType.toUpperCase());
      paramIndex += 1;
    }

    if (filters.startDate) {
      conditions.push(`lt.posted_at >= $${paramIndex}`);
      values.push(new Date(filters.startDate));
      paramIndex += 1;
    }

    if (filters.endDate) {
      conditions.push(`lt.posted_at <= $${paramIndex}`);
      values.push(new Date(filters.endDate));
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    // 1. Contagem total de lançamentos
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM ledger_entries le
      INNER JOIN ledger_accounts la ON la.id = le.account_id
      INNER JOIN ledger_transactions lt ON lt.id = le.transaction_id
      WHERE ${whereClause};
    `;
    const countResult = client ? await queryOneClient(client, countSql, values) : await queryOne(countSql, values);
    const totalCount = countResult ? countResult.total : 0;

    // 2. Consulta paginada dos registros do extrato
    values.push(pagination.limit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    values.push(pagination.offset);
    const offsetParam = `$${paramIndex}`;

    const dataSql = `
      SELECT 
        lt.id AS transaction_id,
        lt.reference_code,
        lt.operation_type,
        le.direction,
        le.amount,
        le.currency,
        lt.description,
        lt.metadata,
        lt.posted_at
      FROM ledger_entries le
      INNER JOIN ledger_accounts la ON la.id = le.account_id
      INNER JOIN ledger_transactions lt ON lt.id = le.transaction_id
      WHERE ${whereClause}
      ORDER BY lt.posted_at DESC, le.sequence ASC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }

  /**
   * Consulta os dados completos para emissão de recibo oficial de uma transação contábil.
   *
   * @param {string} transactionId
   * @param {import('pg').PoolClient} [client]
   */
  async getTransactionReceiptData(transactionId, client = null) {
    const text = `
      SELECT 
        lt.id AS transaction_id,
        lt.reference_code,
        lt.operation_type,
        lt.status,
        lt.amount,
        lt.currency,
        lt.description,
        lt.metadata,
        lt.posted_at,
        la.user_id,
        p.full_name,
        u.email,
        u.phone_number
      FROM ledger_transactions lt
      LEFT JOIN ledger_entries le ON le.transaction_id = lt.id
      LEFT JOIN ledger_accounts la ON la.id = le.account_id AND la.user_id IS NOT NULL
      LEFT JOIN users u ON u.id = la.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE lt.id = $1
      LIMIT 1;
    `;

    return client ? queryOneClient(client, text, [transactionId]) : queryOne(text, [transactionId]);
  }

  /**
   * Lista as carteiras cadastradas na plataforma com filtros e paginação para supervisão administrativa.
   *
   * @param {object} [filters={}] - { status, hasBalance }
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listWallets(filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (filters.status) {
      conditions.push(`w.status = $${paramIndex}`);
      values.push(filters.status.toUpperCase());
      paramIndex += 1;
    }

    if (filters.hasBalance === true) {
      conditions.push(`w.ledger_balance > 0`);
    } else if (filters.hasBalance === false) {
      conditions.push(`w.ledger_balance = 0`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM wallets w
      ${whereClause};
    `;
    const countResult = client ? await queryOneClient(client, countSql, values) : await queryOne(countSql, values);
    const totalCount = countResult ? countResult.total : 0;

    values.push(pagination.limit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    values.push(pagination.offset);
    const offsetParam = `$${paramIndex}`;

    const dataSql = `
      SELECT 
        w.id,
        w.user_id,
        w.currency,
        w.status,
        w.ledger_balance,
        w.available_balance,
        w.locked_balance,
        w.created_at,
        u.email,
        p.full_name
      FROM wallets w
      INNER JOIN users u ON u.id = w.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      ${whereClause}
      ORDER BY w.ledger_balance DESC, w.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }
}

// Instância singleton do repositório de carteiras
const walletRepository = new WalletRepository();

module.exports = walletRepository;