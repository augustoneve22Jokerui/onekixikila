const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');
const { escapeSqlLike } = require('../../shared/security/sanitize');

/**
 * Repositório de acesso a dados SQL para Grupos de Kixikila, Regulamentos e Localizações.
 * Executa consultas diretas no Neon PostgreSQL com junções entre `groups`, `group_rules`,
 * `group_locations`, `group_memberships` e cálculo de proximidade geográfica.
 */
class GroupsRepository {
  /**
   * Insere o registo principal de um novo grupo de Kixikila na tabela groups.
   *
   * @param {object} params
   * @param {string} params.creatorId
   * @param {string} params.leaderId
   * @param {string} params.name
   * @param {string} params.slug
   * @param {string|null} params.description
   * @param {string} params.frequency - 'DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY'
   * @param {number|bigint} params.contributionAmount - Valor da quota em Kwanzas (AOA)
   * @param {number} params.minMembers
   * @param {number} params.maxMembers
   * @param {string|null} params.startDate
   * @param {boolean} params.isPrivate
   * @param {boolean} params.allowAutoDebit
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async createGroup(params, client = null) {
    const {
      creatorId,
      leaderId,
      name,
      slug,
      description = null,
      frequency,
      contributionAmount,
      minMembers = 3,
      maxMembers = 12,
      startDate = null,
      isPrivate = false,
      allowAutoDebit = false
    } = params;

    const text = `
      INSERT INTO groups (
        creator_id,
        leader_id,
        name,
        slug,
        description,
        status,
        frequency,
        contribution_amount,
        currency,
        min_members,
        max_members,
        current_cycle,
        total_cycles,
        start_date,
        is_private,
        allow_auto_debit
      )
      VALUES ($1, $2, $3, $4, $5, 'FORMATION', $6, $7, 'AOA', $8, $9, 1, 1, $10, $11, $12)
      RETURNING *;
    `;

    const values = [
      creatorId,
      leaderId,
      name,
      slug,
      description,
      frequency,
      contributionAmount,
      minMembers,
      maxMembers,
      startDate,
      isPrivate,
      allowAutoDebit
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Insere as regras e regulamento operacional vinculativo em group_rules.
   *
   * @param {object} params
   * @param {string} params.groupId
   * @param {string} params.rotationType
   * @param {number} params.gracePeriodDays
   * @param {string} params.lateFeeType
   * @param {number|bigint} params.lateFeeValue
   * @param {boolean} params.allowEarlyPayout
   * @param {boolean} params.requireAdminApprovalToJoin
   * @param {boolean} params.requireIdentityVerification
   * @param {string|null} params.termsAndConditions
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createGroupRules(params, client = null) {
    const {
      groupId,
      rotationType = 'FIXED',
      gracePeriodDays = 2,
      lateFeeType = 'FIXED',
      lateFeeValue = 0,
      allowEarlyPayout = false,
      requireAdminApprovalToJoin = true,
      requireIdentityVerification = true,
      termsAndConditions = null
    } = params;

    const text = `
      INSERT INTO group_rules (
        group_id,
        rotation_type,
        grace_period_days,
        late_fee_type,
        late_fee_value,
        allow_early_payout,
        require_admin_approval_to_join,
        require_identity_verification,
        terms_and_conditions
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;

    const values = [
      groupId,
      rotationType,
      gracePeriodDays,
      lateFeeType,
      lateFeeValue,
      allowEarlyPayout,
      requireAdminApprovalToJoin,
      requireIdentityVerification,
      termsAndConditions
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Insere os dados de georreferenciação aproximada para descoberta em group_locations.
   *
   * @param {object} params
   * @param {string} params.groupId
   * @param {string} params.province
   * @param {string} params.municipality
   * @param {string|null} [params.neighborhood]
   * @param {number|null} [params.approximateLatitude]
   * @param {number|null} [params.approximateLongitude]
   * @param {number} [params.radiusMeters=5000]
   * @param {boolean} [params.isPubliclyDiscoverable=true]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createGroupLocation(params, client = null) {
    const {
      groupId,
      province,
      municipality,
      neighborhood = null,
      approximateLatitude = null,
      approximateLongitude = null,
      radiusMeters = 5000,
      isPubliclyDiscoverable = true
    } = params;

    const text = `
      INSERT INTO group_locations (
        group_id,
        country,
        province,
        municipality,
        neighborhood,
        approximate_latitude,
        approximate_longitude,
        radius_meters,
        is_publicly_discoverable
      )
      VALUES ($1, 'AGO', $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;

    const values = [
      groupId,
      province,
      municipality,
      neighborhood,
      approximateLatitude,
      approximateLongitude,
      radiusMeters,
      isPubliclyDiscoverable
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Obtém a ficha integral do grupo pelo seu UUID, unindo regras, localização, dados do líder e contagem de membros.
   *
   * @param {string} groupId
   * @param {import('pg').PoolClient} [client]
   */
  async findById(groupId, client = null) {
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
        gr.allow_early_payout,
        gr.require_admin_approval_to_join,
        gr.require_identity_verification,
        gr.terms_and_conditions,
        gl.province,
        gl.municipality,
        gl.neighborhood,
        gl.approximate_latitude,
        gl.approximate_longitude,
        gl.radius_meters,
        gl.is_publicly_discoverable,
        lp.full_name AS leader_name,
        lp.avatar_url AS leader_avatar_url,
        (
          SELECT COUNT(*)::integer 
          FROM group_memberships gm 
          WHERE gm.group_id = g.id AND gm.status = 'ACTIVE'
        ) AS active_members_count
      FROM groups g
      LEFT JOIN group_rules gr ON gr.group_id = g.id
      LEFT JOIN group_locations gl ON gl.group_id = g.id
      LEFT JOIN user_profiles lp ON lp.user_id = g.leader_id
      WHERE g.id = $1;
    `;

    return client ? queryOneClient(client, text, [groupId]) : queryOne(text, [groupId]);
  }

  /**
   * Obtém a ficha do grupo pelo seu slug textual de URL.
   *
   * @param {string} slug
   * @param {import('pg').PoolClient} [client]
   */
  async findBySlug(slug, client = null) {
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
        gr.rotation_type,
        gr.grace_period_days,
        gr.late_fee_type,
        gr.late_fee_value,
        gr.allow_early_payout,
        gr.require_admin_approval_to_join,
        gr.require_identity_verification,
        gr.terms_and_conditions,
        gl.province,
        gl.municipality,
        gl.neighborhood,
        lp.full_name AS leader_name,
        (
          SELECT COUNT(*)::integer 
          FROM group_memberships gm 
          WHERE gm.group_id = g.id AND gm.status = 'ACTIVE'
        ) AS active_members_count
      FROM groups g
      LEFT JOIN group_rules gr ON gr.group_id = g.id
      LEFT JOIN group_locations gl ON gl.group_id = g.id
      LEFT JOIN user_profiles lp ON lp.user_id = g.leader_id
      WHERE g.slug = $1;
    `;

    return client ? queryOneClient(client, text, [slug]) : queryOne(text, [slug]);
  }

  /**
   * Atualiza dados descritivos e cadastrais do grupo.
   *
   * @param {string} groupId
   * @param {object} updateData
   * @param {import('pg').PoolClient} [client]
   */
  async updateGroup(groupId, updateData, client = null) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    const allowedUpdates = {
      name: 'name',
      description: 'description',
      isPrivate: 'is_private',
      allowAutoDebit: 'allow_auto_debit',
      startDate: 'start_date',
      endDate: 'end_date'
    };

    for (const [prop, column] of Object.entries(allowedUpdates)) {
      if (updateData[prop] !== undefined) {
        fields.push(`${column} = $${paramIndex}`);
        values.push(updateData[prop]);
        paramIndex += 1;
      }
    }

    if (fields.length === 0) {
      return this.findById(groupId, client);
    }

    values.push(groupId);
    const text = `
      UPDATE groups
      SET ${fields.join(', ')},
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $${paramIndex}
      RETURNING *;
    `;

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Atualiza o regulamento interno e regras operacionais do grupo.
   *
   * @param {string} groupId
   * @param {object} rulesData
   * @param {import('pg').PoolClient} [client]
   */
  async updateGroupRules(groupId, rulesData, client = null) {
    const fields = ['version = version + 1'];
    const values = [];
    let paramIndex = 1;

    const allowedRules = {
      rotationType: 'rotation_type',
      gracePeriodDays: 'grace_period_days',
      lateFeeType: 'late_fee_type',
      lateFeeValue: 'late_fee_value',
      allowEarlyPayout: 'allow_early_payout',
      requireAdminApprovalToJoin: 'require_admin_approval_to_join',
      requireIdentityVerification: 'require_identity_verification',
      termsAndConditions: 'terms_and_conditions'
    };

    for (const [prop, column] of Object.entries(allowedRules)) {
      if (rulesData[prop] !== undefined) {
        fields.push(`${column} = $${paramIndex}`);
        values.push(rulesData[prop]);
        paramIndex += 1;
      }
    }

    values.push(groupId);
    const text = `
      UPDATE group_rules
      SET ${fields.join(', ')},
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE group_id = $${paramIndex}
      RETURNING *;
    `;

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Atualiza a georreferenciação aproximada do grupo.
   *
   * @param {string} groupId
   * @param {object} locationData
   * @param {import('pg').PoolClient} [client]
   */
  async updateGroupLocation(groupId, locationData, client = null) {
    const text = `
      UPDATE group_locations
      SET province = $1,
          municipality = $2,
          neighborhood = $3,
          approximate_latitude = $4,
          approximate_longitude = $5,
          radius_meters = $6,
          is_publicly_discoverable = $7,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE group_id = $8
      RETURNING *;
    `;

    const values = [
      locationData.province,
      locationData.municipality,
      locationData.neighborhood || null,
      locationData.approximateLatitude || null,
      locationData.approximateLongitude || null,
      locationData.radiusMeters || 5000,
      locationData.isPubliclyDiscoverable !== undefined ? locationData.isPubliclyDiscoverable : true,
      groupId
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Altera o estado do grupo de Kixikila (ex: FORMATION -> ACTIVE -> COMPLETED).
   *
   * @param {string} groupId
   * @param {string} newStatus
   * @param {import('pg').PoolClient} [client]
   */
  async updateStatus(groupId, newStatus, client = null) {
    const text = `
      UPDATE groups
      SET status = $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2
      RETURNING id, status, updated_at;
    `;

    return client ? queryOneClient(client, text, [newStatus, groupId]) : queryOne(text, [newStatus, groupId]);
  }

  /**
   * Substitui formalmente o líder titular do grupo.
   *
   * @param {string} groupId
   * @param {string} newLeaderId
   * @param {import('pg').PoolClient} [client]
   */
  async updateLeader(groupId, newLeaderId, client = null) {
    const text = `
      UPDATE groups
      SET leader_id = $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2
      RETURNING id, leader_id, updated_at;
    `;

    return client ? queryOneClient(client, text, [newLeaderId, groupId]) : queryOne(text, [newLeaderId, groupId]);
  }

  /**
   * Verifica se determinado slug já está em utilização.
   *
   * @param {string} slug
   * @param {string|null} [excludeGroupId=null]
   * @param {import('pg').PoolClient} [client]
   */
  async isSlugTaken(slug, excludeGroupId = null, client = null) {
    const text = excludeGroupId
      ? `SELECT 1 FROM groups WHERE slug = $1 AND id <> $2 LIMIT 1;`
      : `SELECT 1 FROM groups WHERE slug = $1 LIMIT 1;`;

    const params = excludeGroupId ? [slug, excludeGroupId] : [slug];
    const result = client ? await queryOneClient(client, text, params) : await queryOne(text, params);
    return Boolean(result);
  }

  /**
   * Consulta paginada e filtrada de grupos públicos ou ativos para o catálogo de descoberta.
   *
   * @param {object} filters
   * @param {object} pagination - { limit, offset }
   * @param {import('pg').PoolClient} [client]
   */
  async listGroups(filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    // Filtro padrão de privacidade para listagem pública
    if (filters.isPrivate !== undefined) {
      conditions.push(`g.is_private = $${paramIndex}`);
      values.push(filters.isPrivate);
      paramIndex += 1;
    }

    if (filters.status) {
      conditions.push(`g.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex += 1;
    }

    if (filters.frequency) {
      conditions.push(`g.frequency = $${paramIndex}`);
      values.push(filters.frequency);
      paramIndex += 1;
    }

    if (filters.minAmount) {
      conditions.push(`g.contribution_amount >= $${paramIndex}`);
      values.push(filters.minAmount);
      paramIndex += 1;
    }

    if (filters.maxAmount) {
      conditions.push(`g.contribution_amount <= $${paramIndex}`);
      values.push(filters.maxAmount);
      paramIndex += 1;
    }

    if (filters.province) {
      conditions.push(`gl.province ILIKE $${paramIndex}`);
      values.push(`%${escapeSqlLike(filters.province)}%`);
      paramIndex += 1;
    }

    if (filters.municipality) {
      conditions.push(`gl.municipality ILIKE $${paramIndex}`);
      values.push(`%${escapeSqlLike(filters.municipality)}%`);
      paramIndex += 1;
    }

    if (filters.search) {
      const searchPattern = `%${escapeSqlLike(filters.search)}%`;
      conditions.push(`(g.name ILIKE $${paramIndex} OR g.description ILIKE $${paramIndex})`);
      values.push(searchPattern);
      paramIndex += 1;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Contagem total
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM groups g
      LEFT JOIN group_locations gl ON gl.group_id = g.id
      ${whereClause};
    `;
    const countResult = client ? await queryOneClient(client, countSql, values) : await queryOne(countSql, values);
    const totalCount = countResult ? countResult.total : 0;

    // Linhas paginadas
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
        g.description,
        g.status,
        g.frequency,
        g.contribution_amount,
        g.currency,
        g.min_members,
        g.max_members,
        g.start_date,
        g.is_private,
        gl.province,
        gl.municipality,
        gl.neighborhood,
        lp.full_name AS leader_name,
        (
          SELECT COUNT(*)::integer 
          FROM group_memberships gm 
          WHERE gm.group_id = g.id AND gm.status = 'ACTIVE'
        ) AS active_members_count
      FROM groups g
      LEFT JOIN group_locations gl ON gl.group_id = g.id
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

  /**
   * Busca grupos públicos próximos com base nas coordenadas aproximadas do utilizador (Fórmula de Haversine).
   *
   * @param {object} params
   * @param {number} params.latitude
   * @param {number} params.longitude
   * @param {number} [params.radiusMeters=10000]
   * @param {number} [params.limit=20]
   * @param {number} [params.offset=0]
   * @param {import('pg').PoolClient} [client]
   */
  async findNearbyGroups(params, client = null) {
    const { latitude, longitude, radiusMeters = 10000, limit = 20, offset = 0 } = params;

    const text = `
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
        gl.province,
        gl.municipality,
        gl.neighborhood,
        ROUND(
          (6371000 * acos(
            LEAST(1.0, GREATEST(-1.0,
              cos(radians($1)) * cos(radians(gl.approximate_latitude)) *
              cos(radians(gl.approximate_longitude) - radians($2)) +
              sin(radians($1)) * sin(radians(gl.approximate_latitude))
            ))
          ))::numeric, 0
        ) AS distance_meters,
        (
          SELECT COUNT(*)::integer 
          FROM group_memberships gm 
          WHERE gm.group_id = g.id AND gm.status = 'ACTIVE'
        ) AS active_members_count
      FROM groups g
      INNER JOIN group_locations gl ON gl.group_id = g.id
      WHERE g.is_private = FALSE
        AND g.status IN ('FORMATION', 'ACTIVE')
        AND gl.is_publicly_discoverable = TRUE
        AND gl.approximate_latitude IS NOT NULL
        AND gl.approximate_longitude IS NOT NULL
        AND (
          6371000 * acos(
            LEAST(1.0, GREATEST(-1.0,
              cos(radians($1)) * cos(radians(gl.approximate_latitude)) *
              cos(radians(gl.approximate_longitude) - radians($2)) +
              sin(radians($1)) * sin(radians(gl.approximate_latitude))
            ))
          )
        ) <= $3
      ORDER BY distance_meters ASC
      LIMIT $4 OFFSET $5;
    `;

    const values = [latitude, longitude, radiusMeters, limit, offset];
    const result = client ? await queryClient(client, text, values) : await query(text, values);
    return result.rows;
  }
}

// Instância singleton do repositório de grupos
const groupsRepository = new GroupsRepository();

module.exports = groupsRepository;