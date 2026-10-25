const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');
const { escapeSqlLike } = require('../../shared/security/sanitize');

/**
 * Repositório de acesso a dados SQL para o módulo de Utilizadores e Perfis.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para consulta,
 * atualização de dados cadastrais, preferências, geolocalização e gestão administrativa.
 */
class UsersRepository {
  /**
   * Obtém a ficha cadastral completa de um utilizador unindo dados da conta,
   * perfil pessoal, nível de verificação de identidade (KYC) e estado da carteira.
   *
   * @param {string} userId - UUID do utilizador
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   */
  async findById(userId, client = null) {
    const text = `
      SELECT 
        u.id,
        u.email,
        u.phone_number,
        u.role,
        u.status,
        u.is_email_verified,
        u.is_phone_verified,
        u.email_verified_at,
        u.phone_verified_at,
        u.created_at,
        u.last_login_at,
        p.full_name,
        p.preferred_name,
        p.avatar_url,
        p.date_of_birth,
        p.gender,
        p.country,
        p.province,
        p.municipality,
        p.neighborhood,
        p.address_line,
        p.latitude,
        p.longitude,
        p.location_authorized,
        p.preferred_locale,
        p.preferred_currency,
        p.notification_preferences,
        p.bio,
        COALESCE(iv.status, 'PENDING') AS identity_status,
        COALESCE(iv.tier, 'TIER_1_UNVERIFIED') AS identity_tier,
        w.id AS wallet_id,
        w.status AS wallet_status
      FROM users u
      LEFT JOIN user_profiles p ON p.user_id = u.id
      LEFT JOIN identity_verifications iv ON iv.user_id = u.id
      LEFT JOIN wallets w ON w.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL;
    `;

    return client ? queryOneClient(client, text, [userId]) : queryOne(text, [userId]);
  }

  /**
   * Obtém o perfil público higienizado de um utilizador para exibição em grupos e interações.
   * Não expõe contactos privados, documentos, saldos ou dados de auditoria.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   */
  async getPublicProfile(userId, client = null) {
    const text = `
      SELECT 
        u.id,
        u.role,
        u.status,
        u.created_at AS member_since,
        p.full_name,
        p.preferred_name,
        p.avatar_url,
        p.province,
        p.municipality,
        p.bio,
        COALESCE(iv.tier, 'TIER_1_UNVERIFIED') AS identity_tier
      FROM users u
      INNER JOIN user_profiles p ON p.user_id = u.id
      LEFT JOIN identity_verifications iv ON iv.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL;
    `;

    return client ? queryOneClient(client, text, [userId]) : queryOne(text, [userId]);
  }

  /**
   * Atualiza dinamicamente as informações do perfil pessoal do utilizador em user_profiles.
   *
   * @param {string} userId
   * @param {object} profileData
   * @param {import('pg').PoolClient} [client]
   */
  async updateProfile(userId, profileData, client = null) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    const fieldMap = {
      fullName: 'full_name',
      preferredName: 'preferred_name',
      dateOfBirth: 'date_of_birth',
      gender: 'gender',
      province: 'province',
      municipality: 'municipality',
      neighborhood: 'neighborhood',
      addressLine: 'address_line',
      bio: 'bio',
      avatarUrl: 'avatar_url'
    };

    for (const [prop, column] of Object.entries(fieldMap)) {
      if (profileData[prop] !== undefined) {
        fields.push(`${column} = $${paramIndex}`);
        values.push(profileData[prop]);
        paramIndex += 1;
      }
    }

    if (fields.length === 0) {
      return this.findById(userId, client);
    }

    values.push(userId);
    const text = `
      UPDATE user_profiles
      SET ${fields.join(', ')},
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE user_id = $${paramIndex}
      RETURNING *;
    `;

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Atualiza a localização aproximada e o consentimento de georreferenciação.
   *
   * @param {string} userId
   * @param {object} locationData
   * @param {import('pg').PoolClient} [client]
   */
  async updateLocation(userId, locationData, client = null) {
    const {
      latitude,
      longitude,
      province,
      municipality,
      neighborhood,
      locationAuthorized
    } = locationData;

    const text = `
      UPDATE user_profiles
      SET latitude = $1,
          longitude = $2,
          province = COALESCE($3, province),
          municipality = COALESCE($4, municipality),
          neighborhood = COALESCE($5, neighborhood),
          location_authorized = $6,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE user_id = $7
      RETURNING user_id, latitude, longitude, province, municipality, neighborhood, location_authorized;
    `;

    const values = [
      latitude,
      longitude,
      province || null,
      municipality || null,
      neighborhood || null,
      locationAuthorized,
      userId
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Atualiza as preferências de notificação, idioma e moeda do utilizador.
   *
   * @param {string} userId
   * @param {object} preferencesData
   * @param {import('pg').PoolClient} [client]
   */
  async updatePreferences(userId, preferencesData, client = null) {
    const { preferredLocale, preferredCurrency, notificationPreferences } = preferencesData;

    const fields = [];
    const values = [];
    let paramIndex = 1;

    if (preferredLocale !== undefined) {
      fields.push(`preferred_locale = $${paramIndex}`);
      values.push(preferredLocale);
      paramIndex += 1;
    }

    if (preferredCurrency !== undefined) {
      fields.push(`preferred_currency = $${paramIndex}`);
      values.push(preferredCurrency);
      paramIndex += 1;
    }

    if (notificationPreferences !== undefined) {
      fields.push(`notification_preferences = $${paramIndex}::jsonb`);
      values.push(JSON.stringify(notificationPreferences));
      paramIndex += 1;
    }

    if (fields.length === 0) {
      return this.findById(userId, client);
    }

    values.push(userId);
    const text = `
      UPDATE user_profiles
      SET ${fields.join(', ')},
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE user_id = $${paramIndex}
      RETURNING preferred_locale, preferred_currency, notification_preferences;
    `;

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Atualiza o papel global de um utilizador (Operação administrativa RBAC).
   *
   * @param {string} userId
   * @param {string} newRole
   * @param {import('pg').PoolClient} [client]
   */
  async updateRole(userId, newRole, client = null) {
    const text = `
      UPDATE users
      SET role = $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2
      RETURNING id, role, updated_at;
    `;
    return client ? queryOneClient(client, text, [newRole, userId]) : queryOne(text, [newRole, userId]);
  }

  /**
   * Altera o estado operacional do utilizador (SUSPENDED, BLOCKED, ACTIVE).
   *
   * @param {string} userId
   * @param {string} newStatus
   * @param {import('pg').PoolClient} [client]
   */
  async updateStatus(userId, newStatus, client = null) {
    const text = `
      UPDATE users
      SET status = $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2
      RETURNING id, status, updated_at;
    `;
    return client ? queryOneClient(client, text, [newStatus, userId]) : queryOne(text, [newStatus, userId]);
  }

  /**
   * Executa a desativação ou encerramento lógico (Soft Delete) de uma conta.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   */
  async softDelete(userId, client = null) {
    const text = `
      UPDATE users
      SET status = 'DEACTIVATED',
          deleted_at = NOW() AT TIME ZONE 'UTC',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $1
      RETURNING id, status, deleted_at;
    `;
    return client ? queryOneClient(client, text, [userId]) : queryOne(text, [userId]);
  }

  /**
   * Consulta paginada e filtrada de utilizadores para governança administrativa.
   *
   * @param {object} filters
   * @param {object} pagination - { limit, offset }
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listUsers(filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = ['u.deleted_at IS NULL'];
    const values = [];
    let paramIndex = 1;

    if (filters.status) {
      conditions.push(`u.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex += 1;
    }

    if (filters.role) {
      conditions.push(`u.role = $${paramIndex}`);
      values.push(filters.role);
      paramIndex += 1;
    }

    if (filters.province) {
      conditions.push(`p.province ILIKE $${paramIndex}`);
      values.push(`%${escapeSqlLike(filters.province)}%`);
      paramIndex += 1;
    }

    if (filters.municipality) {
      conditions.push(`p.municipality ILIKE $${paramIndex}`);
      values.push(`%${escapeSqlLike(filters.municipality)}%`);
      paramIndex += 1;
    }

    if (filters.search) {
      const searchPattern = `%${escapeSqlLike(filters.search)}%`;
      conditions.push(
        `(p.full_name ILIKE $${paramIndex} OR u.email ILIKE $${paramIndex} OR u.phone_number ILIKE $${paramIndex})`
      );
      values.push(searchPattern);
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    // 1. Contagem total de registos correspondentes
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM users u
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE ${whereClause};
    `;
    const countResult = client ? await queryOneClient(client, countSql, values) : await queryOne(countSql, values);
    const totalCount = countResult ? countResult.total : 0;

    // 2. Consulta dos registos paginados
    values.push(pagination.limit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    values.push(pagination.offset);
    const offsetParam = `$${paramIndex}`;

    const dataSql = `
      SELECT 
        u.id,
        u.email,
        u.phone_number,
        u.role,
        u.status,
        u.is_email_verified,
        u.is_phone_verified,
        u.created_at,
        u.last_login_at,
        p.full_name,
        p.preferred_name,
        p.province,
        p.municipality,
        COALESCE(iv.tier, 'TIER_1_UNVERIFIED') AS identity_tier
      FROM users u
      LEFT JOIN user_profiles p ON p.user_id = u.id
      LEFT JOIN identity_verifications iv ON iv.user_id = u.id
      WHERE ${whereClause}
      ORDER BY u.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }
}

// Instância singleton do repositório de utilizadores
const usersRepository = new UsersRepository();

module.exports = usersRepository;