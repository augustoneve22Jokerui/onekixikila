const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');
const { escapeSqlLike } = require('../../shared/security/sanitize');

/**
 * Repositório de acesso a dados SQL para a tabela `group_locations`.
 * Executa consultas diretas e cálculos geoespaciais esféricos (Fórmula de Haversine) no Neon PostgreSQL
 * para persistência de localizações territoriais, descoberta por proximidade em Angola
 * e listagem de províncias e municípios com grupos ativos.
 */
class LocationsRepository {
  /**
   * Insere ou atualiza a localização territorial aproximada de um grupo de Kixikila.
   *
   * @param {object} params
   * @param {string} params.groupId
   * @param {string} params.province
   * @param {string} params.municipality
   * @param {string|null} [params.neighborhood]
   * @param {string|null} [params.referencePoint]
   * @param {number|null} [params.approximateLatitude]
   * @param {number|null} [params.approximateLongitude]
   * @param {number} [params.radiusMeters=5000]
   * @param {boolean} [params.isPubliclyDiscoverable=true]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async upsertGroupLocation(params, client = null) {
    const {
      groupId,
      province,
      municipality,
      neighborhood = null,
      referencePoint = null,
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
        reference_point,
        approximate_latitude,
        approximate_longitude,
        radius_meters,
        is_publicly_discoverable
      )
      VALUES ($1, 'AGO', $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (group_id)
      DO UPDATE SET
        province = EXCLUDED.province,
        municipality = EXCLUDED.municipality,
        neighborhood = EXCLUDED.neighborhood,
        reference_point = EXCLUDED.reference_point,
        approximate_latitude = EXCLUDED.approximate_latitude,
        approximate_longitude = EXCLUDED.approximate_longitude,
        radius_meters = EXCLUDED.radius_meters,
        is_publicly_discoverable = EXCLUDED.is_publicly_discoverable,
        updated_at = NOW() AT TIME ZONE 'UTC'
      RETURNING *;
    `;

    const values = [
      groupId,
      province,
      municipality,
      neighborhood,
      referencePoint,
      approximateLatitude,
      approximateLongitude,
      radiusMeters,
      isPubliclyDiscoverable
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza o registo de localização vinculado a determinado grupo.
   *
   * @param {string} groupId
   * @param {import('pg').PoolClient} [client]
   */
  async findByGroupId(groupId, client = null) {
    const text = `
      SELECT 
        id,
        group_id,
        country,
        province,
        municipality,
        neighborhood,
        reference_point,
        approximate_latitude,
        approximate_longitude,
        radius_meters,
        is_publicly_discoverable,
        created_at,
        updated_at
      FROM group_locations
      WHERE group_id = $1;
    `;

    return client ? queryOneClient(client, text, [groupId]) : queryOne(text, [groupId]);
  }

  /**
   * Busca grupos de Kixikila em um raio esférico (em metros) a partir das coordenadas informadas.
   * Utiliza aproximação trigonométrica de Haversine otimizada em SQL e limita a precisão por privacidade.
   *
   * @param {object} params
   * @param {number} params.latitude - Latitude central
   * @param {number} params.longitude - Longitude central
   * @param {number} [params.radiusMeters=10000] - Raio de varredura em metros
   * @param {number} [params.limit=20]
   * @param {number} [params.offset=0]
   * @param {object} [params.filters={}] - Filtros opcionais adicionais (frequency, minAmount, maxAmount)
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async searchGroupsByDistance(params, client = null) {
    const {
      latitude,
      longitude,
      radiusMeters = 10000,
      limit = 20,
      offset = 0,
      filters = {}
    } = params;

    const conditions = [
      `g.is_private = FALSE`,
      `g.status IN ('FORMATION', 'ACTIVE')`,
      `gl.is_publicly_discoverable = TRUE`,
      `gl.approximate_latitude IS NOT NULL`,
      `gl.approximate_longitude IS NOT NULL`,
      `(
        6371000 * acos(
          LEAST(1.0, GREATEST(-1.0,
            cos(radians($1)) * cos(radians(gl.approximate_latitude)) *
            cos(radians(gl.approximate_longitude) - radians($2)) +
            sin(radians($1)) * sin(radians(gl.approximate_latitude))
          ))
        )
      ) <= $3`
    ];

    const values = [latitude, longitude, radiusMeters];
    let paramIndex = 4;

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

    const whereClause = conditions.join(' AND ');

    values.push(limit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    values.push(offset);
    const offsetParam = `$${paramIndex}`;

    const text = `
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
        lp.full_name AS leader_name,
        (
          SELECT COUNT(*)::integer 
          FROM group_memberships gm 
          WHERE gm.group_id = g.id AND gm.status = 'ACTIVE'
        ) AS active_members_count
      FROM groups g
      INNER JOIN group_locations gl ON gl.group_id = g.id
      LEFT JOIN user_profiles lp ON lp.user_id = g.leader_id
      WHERE ${whereClause}
      ORDER BY distance_meters ASC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const result = client ? await queryClient(client, text, values) : await query(text, values);
    return result.rows;
  }

  /**
   * Retorna a contagem total de grupos que se enquadram no raio de busca por proximidade.
   *
   * @param {object} params
   * @param {import('pg').PoolClient} [client]
   */
  async countNearbyGroups(params, client = null) {
    const { latitude, longitude, radiusMeters = 10000, filters = {} } = params;

    const conditions = [
      `g.is_private = FALSE`,
      `g.status IN ('FORMATION', 'ACTIVE')`,
      `gl.is_publicly_discoverable = TRUE`,
      `gl.approximate_latitude IS NOT NULL`,
      `gl.approximate_longitude IS NOT NULL`,
      `(
        6371000 * acos(
          LEAST(1.0, GREATEST(-1.0,
            cos(radians($1)) * cos(radians(gl.approximate_latitude)) *
            cos(radians(gl.approximate_longitude) - radians($2)) +
            sin(radians($1)) * sin(radians(gl.approximate_latitude))
          ))
        )
      ) <= $3`
    ];

    const values = [latitude, longitude, radiusMeters];
    let paramIndex = 4;

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

    const whereClause = conditions.join(' AND ');

    const text = `
      SELECT COUNT(*)::integer AS total
      FROM groups g
      INNER JOIN group_locations gl ON gl.group_id = g.id
      WHERE ${whereClause};
    `;

    const result = client ? await queryOneClient(client, text, values) : await queryOne(text, values);
    return result ? result.total : 0;
  }

  /**
   * Lista as províncias de Angola que possuem grupos públicos cadastrados.
   *
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<{ province: string, total_groups: number }>>}
   */
  async listActiveProvinces(client = null) {
    const text = `
      SELECT 
        gl.province,
        COUNT(g.id)::integer AS total_groups
      FROM group_locations gl
      INNER JOIN groups g ON g.id = gl.group_id
      WHERE g.is_private = FALSE
        AND g.status IN ('FORMATION', 'ACTIVE')
        AND gl.is_publicly_discoverable = TRUE
        AND gl.province IS NOT NULL
        AND gl.province <> ''
      GROUP BY gl.province
      ORDER BY total_groups DESC, gl.province ASC;
    `;

    const result = client ? await queryClient(client, text) : await query(text);
    return result.rows;
  }

  /**
   * Lista os municípios de determinada província com grupos ativos.
   *
   * @param {string} province
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<{ municipality: string, total_groups: number }>>}
   */
  async listMunicipalitiesByProvince(province, client = null) {
    const text = `
      SELECT 
        gl.municipality,
        COUNT(g.id)::integer AS total_groups
      FROM group_locations gl
      INNER JOIN groups g ON g.id = gl.group_id
      WHERE g.is_private = FALSE
        AND g.status IN ('FORMATION', 'ACTIVE')
        AND gl.is_publicly_discoverable = TRUE
        AND gl.province ILIKE $1
        AND gl.municipality IS NOT NULL
        AND gl.municipality <> ''
      GROUP BY gl.municipality
      ORDER BY total_groups DESC, gl.municipality ASC;
    `;

    const result = client ? await queryClient(client, text, [province]) : await query(text, [province]);
    return result.rows;
  }
}

// Instância singleton do repositório de localizações
const locationsRepository = new LocationsRepository();

module.exports = locationsRepository;