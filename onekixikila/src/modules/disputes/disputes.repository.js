const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para a tabela `disputes`.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para abertura de contestações,
 * apuração probatória, registro de deliberações de arbitragem e histórico auditável de disputas.
 */
class DisputesRepository {
  /**
   * Insere um novo registo formal de disputa na tabela disputes.
   *
   * @param {object} params
   * @param {string} params.disputeCode - Código de identificação único (ex: DSP-20261024-ABC123XY)
   * @param {string} params.initiatorUserId - UUID do membro requerente
   * @param {string|null} [params.respondentUserId] - UUID da parte reclamada (se houver)
   * @param {string|null} [params.groupId] - UUID do grupo relacionado
   * @param {string|null} [params.contributionId] - UUID da quota contestada
   * @param {string|null} [params.ledgerTransactionId] - Transação contábil sob litígio
   * @param {string} params.category - 'CONTRIBUTION_UNACKNOWLEDGED', 'ROTATION_ORDER_DISPUTE', etc.
   * @param {number|bigint|null} [params.amountContested] - Montante em Kwanzas inteiros (AOA)
   * @param {string} [params.currency='AOA']
   * @param {string} params.description - Relato dos factos
   * @param {string|null} [params.evidenceNotes]
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async createDispute(params, client = null) {
    const {
      disputeCode,
      initiatorUserId,
      respondentUserId = null,
      groupId = null,
      contributionId = null,
      ledgerTransactionId = null,
      category,
      amountContested = null,
      currency = 'AOA',
      description,
      evidenceNotes = null
    } = params;

    const text = `
      INSERT INTO disputes (
        dispute_code,
        initiator_user_id,
        respondent_user_id,
        group_id,
        contribution_id,
        ledger_transaction_id,
        category,
        status,
        amount_contested,
        currency,
        description,
        evidence_notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', $8, $9, $10, $11)
      RETURNING *;
    `;

    const values = [
      disputeCode,
      initiatorUserId,
      respondentUserId,
      groupId,
      contributionId,
      ledgerTransactionId,
      category,
      amountContested,
      currency,
      description,
      evidenceNotes
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza uma disputa pelo seu identificador UUID unindo dados das partes e do grupo.
   *
   * @param {string} disputeId
   * @param {import('pg').PoolClient} [client]
   */
  async findById(disputeId, client = null) {
    const text = `
      SELECT 
        d.id,
        d.dispute_code,
        d.initiator_user_id,
        d.respondent_user_id,
        d.group_id,
        d.contribution_id,
        d.ledger_transaction_id,
        d.category,
        d.status,
        d.amount_contested,
        d.currency,
        d.description,
        d.evidence_notes,
        d.resolution_notes,
        d.resolved_by,
        d.resolved_at,
        d.created_at,
        d.updated_at,
        ip.full_name AS initiator_name,
        iu.email AS initiator_email,
        rp.full_name AS respondent_name,
        ru.email AS respondent_email,
        g.name AS group_name,
        arb.full_name AS resolver_name
      FROM disputes d
      INNER JOIN users iu ON iu.id = d.initiator_user_id
      LEFT JOIN user_profiles ip ON ip.user_id = iu.id
      LEFT JOIN users ru ON ru.id = d.respondent_user_id
      LEFT JOIN user_profiles rp ON rp.user_id = ru.id
      LEFT JOIN groups g ON g.id = d.group_id
      LEFT JOIN user_profiles arb ON arb.user_id = d.resolved_by
      WHERE d.id = $1;
    `;

    return client ? queryOneClient(client, text, [disputeId]) : queryOne(text, [disputeId]);
  }

  /**
   * Localiza uma disputa pelo seu código legível exclusivo.
   *
   * @param {string} disputeCode
   * @param {import('pg').PoolClient} [client]
   */
  async findByCode(disputeCode, client = null) {
    const text = `
      SELECT 
        d.id,
        d.dispute_code,
        d.initiator_user_id,
        d.respondent_user_id,
        d.group_id,
        d.category,
        d.status,
        d.amount_contested,
        d.description,
        d.created_at
      FROM disputes d
      WHERE d.dispute_code = $1;
    `;

    return client ? queryOneClient(client, text, [disputeCode]) : queryOne(text, [disputeCode]);
  }

  /**
   * Atualiza o estado da disputa para fase investigativa preliminar ('UNDER_INVESTIGATION').
   *
   * @param {string} disputeId
   * @param {import('pg').PoolClient} [client]
   */
  async markUnderInvestigation(disputeId, client = null) {
    const text = `
      UPDATE disputes
      SET status = 'UNDER_INVESTIGATION',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $1
      RETURNING *;
    `;

    return client ? queryOneClient(client, text, [disputeId]) : queryOne(text, [disputeId]);
  }

  /**
   * Registra o veredito de arbitragem e encerra a contestação.
   *
   * @param {object} params
   * @param {string} params.disputeId
   * @param {string} params.status - 'RESOLVED_FAVOR_INITIATOR', 'RESOLVED_FAVOR_RESPONDENT', 'CLOSED_DISMISSED'
   * @param {string} params.resolutionNotes - Parecer fundamentado
   * @param {string} params.resolvedBy - UUID do auditor/administrador
   * @param {import('pg').PoolClient} [client]
   */
  async resolveDispute(params, client = null) {
    const { disputeId, status, resolutionNotes, resolvedBy } = params;

    const text = `
      UPDATE disputes
      SET status = $1,
          resolution_notes = $2,
          resolved_by = $3,
          resolved_at = NOW() AT TIME ZONE 'UTC',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $4
      RETURNING *;
    `;

    const values = [status, resolutionNotes, resolvedBy, disputeId];
    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Lista as contestações associadas a determinado utilizador (iniciadas ou contra si reclamadas).
   *
   * @param {string} userId
   * @param {object} [filters={}]
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listUserDisputes(userId, filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = ['(d.initiator_user_id = $1 OR d.respondent_user_id = $1)'];
    const values = [userId];
    let paramIndex = 2;

    if (filters.status) {
      conditions.push(`d.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex += 1;
    }

    if (filters.category) {
      conditions.push(`d.category = $${paramIndex}`);
      values.push(filters.category);
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    // Contagem total
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM disputes d
      WHERE ${whereClause};
    `;
    const countResult = client ? await queryOneClient(client, countSql, values) : await queryOne(countSql, values);
    const totalCount = countResult ? countResult.total : 0;

    // Registos paginados
    values.push(pagination.limit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    values.push(pagination.offset);
    const offsetParam = `$${paramIndex}`;

    const dataSql = `
      SELECT 
        d.id,
        d.dispute_code,
        d.initiator_user_id,
        d.respondent_user_id,
        d.category,
        d.status,
        d.amount_contested,
        d.currency,
        d.created_at,
        d.resolved_at,
        g.name AS group_name
      FROM disputes d
      LEFT JOIN groups g ON g.id = d.group_id
      WHERE ${whereClause}
      ORDER BY d.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }

  /**
   * Lista a fila geral de disputas para o painel de auditoria e governança administrativa.
   *
   * @param {object} [filters={}]
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listAllDisputes(filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (filters.status) {
      conditions.push(`d.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex += 1;
    }

    if (filters.category) {
      conditions.push(`d.category = $${paramIndex}`);
      values.push(filters.category);
      paramIndex += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM disputes d
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
        d.id,
        d.dispute_code,
        d.initiator_user_id,
        d.respondent_user_id,
        d.category,
        d.status,
        d.amount_contested,
        d.currency,
        d.created_at,
        ip.full_name AS initiator_name,
        rp.full_name AS respondent_name,
        g.name AS group_name
      FROM disputes d
      INNER JOIN users iu ON iu.id = d.initiator_user_id
      LEFT JOIN user_profiles ip ON ip.user_id = iu.id
      LEFT JOIN users ru ON ru.id = d.respondent_user_id
      LEFT JOIN user_profiles rp ON rp.user_id = ru.id
      LEFT JOIN groups g ON g.id = d.group_id
      ${whereClause}
      ORDER BY d.created_at ASC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }
}

// Instância singleton do repositório de disputas
const disputesRepository = new DisputesRepository();

module.exports = disputesRepository;