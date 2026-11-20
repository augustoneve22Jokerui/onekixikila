const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');
const { escapeSqlLike } = require('../../shared/security/sanitize');

/**
 * Repositório de persistência SQL para a tabela `audit_events`.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para inserção imutável (append-only),
 * consulta de trilhas de auditoria institucional, histórico de segurança de utilizadores
 * e relatórios de rastreabilidade forense da plataforma OneKixikila.
 */
class AuditRepository {
  /**
   * Grava um novo evento de auditoria institucional imutável na base de dados.
   *
   * @param {object} params
   * @param {string|null} [params.requestId=null] - Identificador de correlação de requisição HTTP (X-Request-ID)
   * @param {string|null} [params.actorUserId=null] - UUID do utilizador que realizou a ação
   * @param {string|null} [params.actorRole='ANONYMOUS'] - Papel do ator no momento da execução
   * @param {string|null} [params.ipAddress=null] - Endereço IP do cliente
   * @param {string|null} [params.userAgent=null] - User-Agent do cliente
   * @param {string} params.action - Ação canónica (ex: 'CREATE', 'UPDATE', 'FINANCIAL_TRANSACTION', etc.)
   * @param {string} params.resourceType - Tipo do recurso afetado (ex: 'WALLET', 'GROUP', 'USER')
   * @param {string|null} [params.resourceId=null] - Identificador do recurso
   * @param {object|null} [params.oldValues=null] - Estado prévio sanitizado
   * @param {object|null} [params.newValues=null] - Novo estado sanitizado
   * @param {object} [params.metadata={}] - Metadados adicionais de contexto
   * @param {import('pg').PoolClient} [client=null] - Conexão transacional opcional
   * @returns {Promise<object>} Registo do evento criado
   */
  async recordAuditEvent(params, client = null) {
    const {
      requestId = null,
      actorUserId = null,
      actorRole = 'ANONYMOUS',
      ipAddress = null,
      userAgent = null,
      action,
      resourceType,
      resourceId = null,
      oldValues = null,
      newValues = null,
      metadata = {}
    } = params;

    const text = `
      INSERT INTO audit_events (
        request_id,
        actor_user_id,
        actor_role,
        ip_address,
        user_agent,
        action,
        resource_type,
        resource_id,
        old_values,
        new_values,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      RETURNING *;
    `;

    const values = [
      requestId,
      actorUserId,
      actorRole,
      ipAddress,
      userAgent,
      action.toUpperCase(),
      resourceType.toUpperCase(),
      resourceId ? String(resourceId) : null,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      JSON.stringify(metadata)
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza um evento de auditoria pelo seu identificador primário UUID,
   * unindo informações cadastrais do utilizador atuante.
   *
   * @param {string} eventId
   * @param {import('pg').PoolClient} [client=null]
   */
  async findById(eventId, client = null) {
    const text = `
      SELECT 
        ae.id,
        ae.request_id,
        ae.actor_user_id,
        ae.actor_role,
        ae.ip_address,
        ae.user_agent,
        ae.action,
        ae.resource_type,
        ae.resource_id,
        ae.old_values,
        ae.new_values,
        ae.metadata,
        ae.created_at,
        u.email AS actor_email,
        p.full_name AS actor_name
      FROM audit_events ae
      LEFT JOIN users u ON u.id = ae.actor_user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE ae.id = $1;
    `;

    return client ? queryOneClient(client, text, [eventId]) : queryOne(text, [eventId]);
  }

  /**
   * Lista eventos de auditoria com suporte a filtros combinados e paginação.
   *
   * @param {object} [filters={}] - { action, resourceType, actorUserId, resourceId, requestId, startDate, endDate }
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listAuditEvents(filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (filters.action) {
      conditions.push(`ae.action = $${paramIndex}`);
      values.push(filters.action.toUpperCase());
      paramIndex += 1;
    }

    if (filters.resourceType) {
      conditions.push(`ae.resource_type = $${paramIndex}`);
      values.push(filters.resourceType.toUpperCase());
      paramIndex += 1;
    }

    if (filters.actorUserId) {
      conditions.push(`ae.actor_user_id = $${paramIndex}`);
      values.push(filters.actorUserId);
      paramIndex += 1;
    }

    if (filters.resourceId) {
      conditions.push(`ae.resource_id = $${paramIndex}`);
      values.push(String(filters.resourceId));
      paramIndex += 1;
    }

    if (filters.requestId) {
      conditions.push(`ae.request_id = $${paramIndex}`);
      values.push(filters.requestId);
      paramIndex += 1;
    }

    if (filters.startDate) {
      conditions.push(`ae.created_at >= $${paramIndex}`);
      values.push(new Date(filters.startDate));
      paramIndex += 1;
    }

    if (filters.endDate) {
      conditions.push(`ae.created_at <= $${paramIndex}`);
      values.push(new Date(filters.endDate));
      paramIndex += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // 1. Contagem total
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM audit_events ae
      ${whereClause};
    `;
    const countResult = client ? await queryOneClient(client, countSql, values) : await queryOne(countSql, values);
    const totalCount = countResult ? countResult.total : 0;

    // 2. Registos paginados
    values.push(pagination.limit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    values.push(pagination.offset);
    const offsetParam = `$${paramIndex}`;

    const dataSql = `
      SELECT 
        ae.id,
        ae.request_id,
        ae.actor_user_id,
        ae.actor_role,
        ae.ip_address,
        ae.action,
        ae.resource_type,
        ae.resource_id,
        ae.old_values,
        ae.new_values,
        ae.metadata,
        ae.created_at,
        u.email AS actor_email,
        p.full_name AS actor_name
      FROM audit_events ae
      LEFT JOIN users u ON u.id = ae.actor_user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      ${whereClause}
      ORDER BY ae.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }

  /**
   * Consulta o histórico de segurança e acesso do próprio utilizador
   * (Logins, encerramentos de sessão, alteração de palavra-passe e dispositivos).
   *
   * @param {string} userId
   * @param {object} [pagination={ limit: 10, offset: 0 }]
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async getUserSecurityHistory(userId, pagination = { limit: 10, offset: 0 }, client = null) {
    const textConditions = `
      WHERE (ae.actor_user_id = $1 OR (ae.resource_type = 'USER' AND ae.resource_id = $1::text))
        AND ae.action IN ('LOGIN', 'LOGOUT', 'PASSWORD_CHANGE', 'ROLE_CHANGE', 'STATUS_CHANGE', 'KYC_REVIEW')
    `;

    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM audit_events ae
      ${textConditions};
    `;
    const countResult = client ? await queryOneClient(client, countSql, [userId]) : await queryOne(countSql, [userId]);
    const totalCount = countResult ? countResult.total : 0;

    const dataSql = `
      SELECT 
        ae.id,
        ae.action,
        ae.ip_address,
        ae.user_agent,
        ae.metadata,
        ae.created_at
      FROM audit_events ae
      ${textConditions}
      ORDER BY ae.created_at DESC
      LIMIT $2 OFFSET $3;
    `;

    const dataResult = client
      ? await queryClient(client, dataSql, [userId, pagination.limit, pagination.offset])
      : await query(dataSql, [userId, pagination.limit, pagination.offset]);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }

  /**
   * Conta a quantidade total de eventos registados num período para relatórios de conformidade.
   *
   * @param {Date} periodStart
   * @param {Date} periodEnd
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<number>}
   */
  async countEventsByPeriod(periodStart, periodEnd, client = null) {
    const text = `
      SELECT COUNT(*)::integer AS event_count
      FROM audit_events
      WHERE created_at >= $1 AND created_at <= $2;
    `;

    const result = client
      ? await queryOneClient(client, text, [periodStart, periodEnd])
      : await queryOne(text, [periodStart, periodEnd]);

    return result ? Number(result.event_count) : 0;
  }
}

// Instância singleton do repositório de auditoria
const auditRepository = new AuditRepository();

module.exports = auditRepository;