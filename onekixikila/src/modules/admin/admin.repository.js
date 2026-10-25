const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');
const { escapeSqlLike } = require('../../shared/security/sanitize');

/**
 * Repositório de persistência SQL para o módulo de Administração e Governança Geral.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para métricas agregadas do painel,
 * auditoria centralizada, intervenções cadastrais de utilizadores e supervisão administrativa de grupos.
 */
class AdminRepository {
  /**
   * Obtém métricas e indicadores consolidados em tempo real para o painel principal de administração.
   *
   * @param {import('pg').PoolClient} [client=null] - Conexão transacional opcional
   * @returns {Promise<{
   *   users: object,
   *   groups: object,
   *   finances: object,
   *   pendingQueues: object
   * }>}
   */
  async getDashboardOverview(client = null) {
    const text = `
      SELECT 
        -- Métricas de Utilizadores
        (SELECT COUNT(*)::integer FROM users WHERE deleted_at IS NULL) AS total_users,
        (SELECT COUNT(*)::integer FROM users WHERE status = 'ACTIVE' AND deleted_at IS NULL) AS active_users,
        (SELECT COUNT(*)::integer FROM users WHERE status IN ('SUSPENDED', 'BLOCKED') AND deleted_at IS NULL) AS restricted_users,
        
        -- Métricas de Grupos de Kixikila
        (SELECT COUNT(*)::integer FROM groups) AS total_groups,
        (SELECT COUNT(*)::integer FROM groups WHERE status = 'ACTIVE') AS active_groups,
        (SELECT COUNT(*)::integer FROM groups WHERE status = 'FORMATION') AS formation_groups,
        (SELECT COUNT(*)::integer FROM groups WHERE status = 'COMPLETED') AS completed_groups,
        (SELECT COUNT(*)::integer FROM groups WHERE status IN ('PAUSED', 'SUSPENDED')) AS paused_or_suspended_groups,

        -- Métricas de Carteiras e Volume em Circulação (Kwanzas - AOA)
        (SELECT COALESCE(SUM(ledger_balance), 0)::bigint FROM wallets) AS total_ledger_balance,
        (SELECT COALESCE(SUM(available_balance), 0)::bigint FROM wallets) AS total_available_balance,
        (SELECT COALESCE(SUM(locked_balance), 0)::bigint FROM wallets) AS total_locked_balance,
        (SELECT COALESCE(SUM(amount), 0)::bigint FROM deposits WHERE status IN ('CONFIRMED', 'SETTLED')) AS total_deposited_volume,
        (SELECT COALESCE(SUM(actual_disbursed_amount), 0)::bigint FROM rotation_schedules WHERE status = 'PAID_OUT') AS total_payouts_volume,

        -- Filas de Pendências e Auditoria
        (SELECT COUNT(*)::integer FROM identity_verifications WHERE status = 'UNDER_REVIEW') AS pending_kyc_reviews,
        (SELECT COUNT(*)::integer FROM disputes WHERE status IN ('OPEN', 'UNDER_INVESTIGATION')) AS active_disputes,
        (SELECT COUNT(*)::integer FROM withdrawals WHERE status = 'REQUESTED') AS pending_withdrawals,
        (SELECT COUNT(*)::integer FROM payment_reconciliations WHERE status IN ('DISCREPANCY_AMOUNT', 'DISCREPANCY_STATUS')) AS discrepancy_reconciliations,
        (SELECT COUNT(*)::integer FROM risk_events WHERE risk_level IN ('HIGH', 'CRITICAL') AND reviewed_by IS NULL) AS severe_unreviewed_risks;
    `;

    const result = client ? await queryOneClient(client, text) : await queryOne(text);

    return {
      users: {
        total: Number(result.total_users || 0),
        active: Number(result.active_users || 0),
        restricted: Number(result.restricted_users || 0)
      },
      groups: {
        total: Number(result.total_groups || 0),
        active: Number(result.active_groups || 0),
        formation: Number(result.formation_groups || 0),
        completed: Number(result.completed_groups || 0),
        pausedOrSuspended: Number(result.paused_or_suspended_groups || 0)
      },
      finances: {
        totalLedgerBalance: Number(result.total_ledger_balance || 0),
        totalAvailableBalance: Number(result.total_available_balance || 0),
        totalLockedBalance: Number(result.total_locked_balance || 0),
        totalDepositedVolume: Number(result.total_deposited_volume || 0),
        totalPayoutsVolume: Number(result.total_payouts_volume || 0)
      },
      pendingQueues: {
        pendingKycReviews: Number(result.pending_kyc_reviews || 0),
        activeDisputes: Number(result.active_disputes || 0),
        pendingWithdrawals: Number(result.pending_withdrawals || 0),
        discrepancyReconciliations: Number(result.discrepancy_reconciliations || 0),
        severeUnreviewedRisks: Number(result.severe_unreviewed_risks || 0)
      }
    };
  }

  /**
   * Consulta os detalhes de auditoria aprofundados de um utilizador específico para a equipa administrativa.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client=null]
   */
  async findUserDetailsForAdmin(userId, client = null) {
    const text = `
      SELECT 
        u.id,
        u.email,
        u.phone_number,
        u.role,
        u.status,
        u.is_email_verified,
        u.is_phone_verified,
        u.terms_accepted_at,
        u.failed_login_attempts,
        u.locked_until,
        u.last_login_at,
        u.created_at,
        u.updated_at,
        p.full_name,
        p.preferred_name,
        p.avatar_url,
        p.date_of_birth,
        p.gender,
        p.province,
        p.municipality,
        p.neighborhood,
        p.address_line,
        p.location_authorized,
        w.id AS wallet_id,
        w.status AS wallet_status,
        w.ledger_balance,
        w.available_balance,
        w.locked_balance,
        COALESCE(iv.status, 'PENDING') AS identity_status,
        COALESCE(iv.tier, 'TIER_1_UNVERIFIED') AS identity_tier,
        (
          SELECT COUNT(*)::integer FROM group_memberships gm WHERE gm.user_id = u.id AND gm.status = 'ACTIVE'
        ) AS active_groups_count,
        (
          SELECT COUNT(*)::integer FROM user_devices ud WHERE ud.user_id = u.id
        ) AS registered_devices_count,
        (
          SELECT COUNT(*)::integer FROM sessions s WHERE s.user_id = u.id AND s.is_revoked = FALSE AND s.expires_at > (NOW() AT TIME ZONE 'UTC')
        ) AS active_sessions_count
      FROM users u
      LEFT JOIN user_profiles p ON p.user_id = u.id
      LEFT JOIN wallets w ON w.user_id = u.id
      LEFT JOIN identity_verifications iv ON iv.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL;
    `;

    return client ? queryOneClient(client, text, [userId]) : queryOne(text, [userId]);
  }

  /**
   * Consulta os dados cadastrais, regras, liderança e balanço operacional de um grupo para supervisão administrativa.
   *
   * @param {string} groupId
   * @param {import('pg').PoolClient} [client=null]
   */
  async findGroupDetailsForAdmin(groupId, client = null) {
    const text = `
      SELECT 
        g.id,
        g.creator_id,
        g.leader_id,
        g.name,
        g.slug,
        g.description,
        g.status,
        g.frequency,
        g.contribution_amount,
        g.currency,
        g.min_members,
        g.max_members,
        g.current_cycle,
        g.total_cycles,
        g.start_date,
        g.end_date,
        g.is_private,
        g.allow_auto_debit,
        g.created_at,
        g.updated_at,
        gr.rotation_type,
        gr.grace_period_days,
        gr.late_fee_type,
        gr.late_fee_value,
        gr.require_identity_verification,
        gl.province,
        gl.municipality,
        gl.neighborhood,
        gl.is_publicly_discoverable,
        lp.full_name AS leader_name,
        lu.email AS leader_email,
        lu.phone_number AS leader_phone,
        (
          SELECT COUNT(*)::integer FROM group_memberships gm WHERE gm.group_id = g.id AND gm.status = 'ACTIVE'
        ) AS active_members_count,
        (
          SELECT COUNT(*)::integer FROM contribution_schedules cs WHERE cs.group_id = g.id
        ) AS total_schedules_count,
        (
          SELECT COALESCE(SUM(c.amount), 0)::bigint FROM contributions c WHERE c.group_id = g.id AND c.status = 'CONFIRMED'
        ) AS total_contributions_collected
      FROM groups g
      LEFT JOIN group_rules gr ON gr.group_id = g.id
      LEFT JOIN group_locations gl ON gl.group_id = g.id
      LEFT JOIN users lu ON lu.id = g.leader_id
      LEFT JOIN user_profiles lp ON lp.user_id = g.leader_id
      WHERE g.id = $1;
    `;

    return client ? queryOneClient(client, text, [groupId]) : queryOne(text, [groupId]);
  }

  /**
   * Atualiza administrativamente o estado de um grupo de Kixikila (ex: suspensão preventiva ou reativação).
   *
   * @param {string} groupId
   * @param {string} newStatus - 'ACTIVE', 'PAUSED', 'SUSPENDED'
   * @param {import('pg').PoolClient} [client=null]
   */
  async updateGroupStatus(groupId, newStatus, client = null) {
    const text = `
      UPDATE groups
      SET status = $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2
      RETURNING id, name, status, updated_at;
    `;

    return client ? queryOneClient(client, text, [newStatus, groupId]) : queryOne(text, [newStatus, groupId]);
  }

  /**
   * Consulta paginada do registo de auditoria institucional (`audit_events`) com filtros detalhados.
   *
   * @param {object} [filters={}] - { action, resourceType, actorUserId, startDate, endDate }
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

    // 1. Contagem total de eventos
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM audit_events ae
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
   * Consulta a lista de grupos para a esteira administrativa com filtros de conformidade.
   *
   * @param {object} [filters={}]
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client=null]
   */
  async listGroupsForAdmin(filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (filters.status) {
      conditions.push(`g.status = $${paramIndex}`);
      values.push(filters.status.toUpperCase());
      paramIndex += 1;
    }

    if (filters.frequency) {
      conditions.push(`g.frequency = $${paramIndex}`);
      values.push(filters.frequency.toUpperCase());
      paramIndex += 1;
    }

    if (filters.search) {
      const searchPattern = `%${escapeSqlLike(filters.search)}%`;
      conditions.push(`(g.name ILIKE $${paramIndex} OR g.slug ILIKE $${paramIndex})`);
      values.push(searchPattern);
      paramIndex += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM groups g
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
        g.id,
        g.name,
        g.slug,
        g.status,
        g.frequency,
        g.contribution_amount,
        g.currency,
        g.min_members,
        g.max_members,
        g.current_cycle,
        g.created_at,
        lp.full_name AS leader_name,
        lu.email AS leader_email,
        (
          SELECT COUNT(*)::integer FROM group_memberships gm WHERE gm.group_id = g.id AND gm.status = 'ACTIVE'
        ) AS active_members_count
      FROM groups g
      LEFT JOIN users lu ON lu.id = g.leader_id
      LEFT JOIN user_profiles lp ON lp.user_id = g.leader_id
      ${whereClause}
      ORDER BY g.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }
}

// Instância singleton do repositório administrativo
const adminRepository = new AdminRepository();

module.exports = adminRepository;