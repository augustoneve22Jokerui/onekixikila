const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para a tabela `risk_events`.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para registo de eventos de anomalia,
 * auditoria comportamental, apuração de volumetria recente para checagens de velocidade (velocity checks),
 * deliberação técnica de revisões e relatórios para a equipa de auditoria e conformidade.
 */
class RiskRepository {
  /**
   * Insere um novo registo formal de evento de risco na base de dados.
   *
   * @param {object} params
   * @param {string|null} [params.userId=null] - UUID do utilizador associado (se identificado)
   * @param {string} params.eventType - Tipo canónico do evento (ex: 'AUTH_BURST_FAILED', 'UNUSUAL_TRANSACTION_AMOUNT')
   * @param {string} [params.riskLevel='LOW'] - 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'
   * @param {string|null} [params.ipAddress=null] - Endereço IP de origem
   * @param {string|null} [params.userAgent=null] - User-Agent do cliente
   * @param {object} [params.details={}] - Metadados estruturados sobre a anomalia
   * @param {string} [params.actionTaken='NONE'] - 'NONE', 'CHALLENGE_REQUIRED', 'TEMPORARY_HOLD', 'ACCOUNT_FROZEN'
   * @param {string|null} [params.reviewedBy=null] - UUID do auditor (se revisado na criação)
   * @param {import('pg').PoolClient} [client=null] - Conexão transacional opcional
   * @returns {Promise<object>} Registo do evento criado
   */
  async createRiskEvent(params, client = null) {
    const {
      userId = null,
      eventType,
      riskLevel = 'LOW',
      ipAddress = null,
      userAgent = null,
      details = {},
      actionTaken = 'NONE',
      reviewedBy = null
    } = params;

    const isReviewed = Boolean(reviewedBy);
    const text = `
      INSERT INTO risk_events (
        user_id,
        event_type,
        risk_level,
        ip_address,
        user_agent,
        details,
        action_taken,
        reviewed_by,
        reviewed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
      RETURNING *;
    `;

    const values = [
      userId,
      eventType,
      riskLevel,
      ipAddress,
      userAgent,
      JSON.stringify(details),
      actionTaken,
      reviewedBy,
      isReviewed ? new Date() : null
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza um evento de risco pelo seu identificador primário UUID,
   * unindo informações cadastrais do utilizador afetado e do auditor deliberante.
   *
   * @param {string} eventId
   * @param {import('pg').PoolClient} [client=null]
   */
  async findById(eventId, client = null) {
    const text = `
      SELECT 
        re.id,
        re.user_id,
        re.event_type,
        re.risk_level,
        re.ip_address,
        re.user_agent,
        re.details,
        re.action_taken,
        re.reviewed_by,
        re.reviewed_at,
        re.created_at,
        u.email,
        u.phone_number,
        p.full_name AS user_name,
        ap.full_name AS reviewer_name,
        au.email AS reviewer_email
      FROM risk_events re
      LEFT JOIN users u ON u.id = re.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      LEFT JOIN users au ON au.id = re.reviewed_by
      LEFT JOIN user_profiles ap ON ap.user_id = au.id
      WHERE re.id = $1;
    `;

    return client ? queryOneClient(client, text, [eventId]) : queryOne(text, [eventId]);
  }

  /**
   * Atualiza a revisão e parecer técnico de um evento de risco por um auditor.
   *
   * @param {object} params
   * @param {string} params.eventId - UUID do evento
   * @param {string} params.reviewedBy - UUID do auditor responsável
   * @param {string} [params.actionTaken] - Nova ação mitigatória aplicada (opcional)
   * @param {object} [params.additionalDetails={}] - Notas de deliberação adicionadas ao payload
   * @param {import('pg').PoolClient} [client=null]
   */
  async reviewRiskEvent(params, client = null) {
    const {
      eventId,
      reviewedBy,
      actionTaken = null,
      additionalDetails = {}
    } = params;

    let text;
    let values;

    if (actionTaken) {
      text = `
        UPDATE risk_events
        SET reviewed_by = $1,
            reviewed_at = NOW() AT TIME ZONE 'UTC',
            action_taken = $2,
            details = details || $3::jsonb
        WHERE id = $4
        RETURNING *;
      `;
      values = [reviewedBy, actionTaken, JSON.stringify(additionalDetails), eventId];
    } else {
      text = `
        UPDATE risk_events
        SET reviewed_by = $1,
            reviewed_at = NOW() AT TIME ZONE 'UTC',
            details = details || $2::jsonb
        WHERE id = $3
        RETURNING *;
      `;
      values = [reviewedBy, JSON.stringify(additionalDetails), eventId];
    }

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Consulta a quantidade de eventos de risco registados para um utilizador
   * ou endereço IP dentro de uma janela temporal configurável (em minutos).
   *
   * @param {object} filter
   * @param {string|null} [filter.userId=null]
   * @param {string|null} [filter.ipAddress=null]
   * @param {number} [filter.windowMinutes=15]
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<{ totalEvents: number, highRiskCount: number }>}
   */
  async getRecentVelocityStats(filter, client = null) {
    const { userId = null, ipAddress = null, windowMinutes = 15 } = filter;

    const conditions = [
      `created_at >= (NOW() AT TIME ZONE 'UTC' - ($1 || ' minutes')::interval)`
    ];
    const values = [windowMinutes];
    let paramIndex = 2;

    if (userId) {
      conditions.push(`user_id = $${paramIndex}`);
      values.push(userId);
      paramIndex += 1;
    }

    if (ipAddress) {
      conditions.push(`ip_address = $${paramIndex}`);
      values.push(ipAddress);
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    const text = `
      SELECT 
        COUNT(*)::integer AS total_events,
        COALESCE(
          SUM(CASE WHEN risk_level IN ('HIGH', 'CRITICAL') THEN 1 ELSE 0 END), 0
        )::integer AS high_risk_count
      FROM risk_events
      WHERE ${whereClause};
    `;

    const result = client ? await queryOneClient(client, text, values) : await queryOne(text, values);

    return {
      totalEvents: result ? Number(result.total_events) : 0,
      highRiskCount: result ? Number(result.high_risk_count) : 0
    };
  }

  /**
   * Apura métricas históricas de movimentação financeira de um utilizador
   * para detecção de desvios padrão (média de transações e maior montante movimentado).
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<{ averageAmount: bigint, maxAmount: bigint, completedCount: number }>}
   */
  async getUserFinancialHistoryStats(userId, client = null) {
    const text = `
      SELECT 
        COALESCE(AVG(amount), 0)::bigint AS avg_amount,
        COALESCE(MAX(amount), 0)::bigint AS max_amount,
        COUNT(*)::integer AS completed_count
      FROM (
        SELECT amount FROM deposits WHERE user_id = $1 AND status IN ('CONFIRMED', 'SETTLED')
        UNION ALL
        SELECT amount FROM internal_transfers WHERE sender_user_id = $1 AND status = 'COMPLETED'
        UNION ALL
        SELECT amount FROM withdrawals WHERE user_id = $1 AND status IN ('APPROVED', 'PROCESSING', 'SETTLED')
      ) tx_history;
    `;

    const result = client ? await queryOneClient(client, text, [userId]) : await queryOne(text, [userId]);

    return {
      averageAmount: result ? BigInt(result.avg_amount) : 0n,
      maxAmount: result ? BigInt(result.max_amount) : 0n,
      completedCount: result ? Number(result.completed_count) : 0
    };
  }

  /**
   * Consulta paginada e filtrada de eventos de risco para a esteira de auditoria.
   *
   * @param {object} [filters={}] - { riskLevel, eventType, actionTaken, userId, isReviewed }
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listRiskEvents(filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (filters.riskLevel) {
      conditions.push(`re.risk_level = $${paramIndex}`);
      values.push(filters.riskLevel.toUpperCase());
      paramIndex += 1;
    }

    if (filters.eventType) {
      conditions.push(`re.event_type = $${paramIndex}`);
      values.push(filters.eventType);
      paramIndex += 1;
    }

    if (filters.actionTaken) {
      conditions.push(`re.action_taken = $${paramIndex}`);
      values.push(filters.actionTaken.toUpperCase());
      paramIndex += 1;
    }

    if (filters.userId) {
      conditions.push(`re.user_id = $${paramIndex}`);
      values.push(filters.userId);
      paramIndex += 1;
    }

    if (filters.isReviewed === true) {
      conditions.push(`re.reviewed_by IS NOT NULL`);
    } else if (filters.isReviewed === false) {
      conditions.push(`re.reviewed_by IS NULL`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // 1. Contagem total
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM risk_events re
      ${whereClause};
    `;
    const countResult = client ? await queryOneClient(client, countSql, values) : await queryOne(countSql, values);
    const totalCount = countResult ? countResult.total : 0;

    // 2. Linhas paginadas
    values.push(pagination.limit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    values.push(pagination.offset);
    const offsetParam = `$${paramIndex}`;

    const dataSql = `
      SELECT 
        re.id,
        re.user_id,
        re.event_type,
        re.risk_level,
        re.ip_address,
        re.action_taken,
        re.reviewed_by,
        re.reviewed_at,
        re.created_at,
        u.email,
        p.full_name AS user_name
      FROM risk_events re
      LEFT JOIN users u ON u.id = re.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      ${whereClause}
      ORDER BY re.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }

  /**
   * Retorna a contagem de eventos de risco severos (HIGH e CRITICAL) pendentes de revisão por um auditor.
   *
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<number>}
   */
  async countUnreviewedSevereEvents(client = null) {
    const text = `
      SELECT COUNT(*)::integer AS severe_unreviewed
      FROM risk_events
      WHERE risk_level IN ('HIGH', 'CRITICAL')
        AND reviewed_by IS NULL;
    `;

    const result = client ? await queryOneClient(client, text) : await queryOne(text);
    return result ? Number(result.severe_unreviewed) : 0;
  }
}

// Instância singleton do repositório de risco
const riskRepository = new RiskRepository();

module.exports = riskRepository;