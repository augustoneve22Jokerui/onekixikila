const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência para Sessões de Utilizador e Dispositivos.
 * Executa consultas SQL diretas parametrizadas no Neon PostgreSQL para controlo
 * de sessões ativas, revogações, rastreio de conexões simultâneas e auditoria de dispositivos.
 */
class SessionsRepository {
  /**
   * Regista uma nova sessão associada a um utilizador e dispositivo.
   *
   * @param {object} sessionData
   * @param {string} sessionData.userId
   * @param {string} [sessionData.deviceId]
   * @param {string} sessionData.tokenHash - Hash SHA-256 do Refresh Token
   * @param {string} sessionData.ipAddress
   * @param {string} sessionData.userAgent
   * @param {Date} sessionData.expiresAt
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createSession(sessionData, client = null) {
    const { userId, deviceId, tokenHash, ipAddress, userAgent, expiresAt } = sessionData;

    const text = `
      INSERT INTO sessions (
        user_id,
        device_id,
        token_hash,
        ip_address,
        user_agent,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, user_id, device_id, ip_address, expires_at, created_at;
    `;

    const values = [userId, deviceId || null, tokenHash, ipAddress, userAgent, expiresAt];
    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza uma sessão pelo seu identificador UUID, trazendo dados do dispositivo associado.
   *
   * @param {string} sessionId
   * @param {import('pg').PoolClient} [client]
   */
  async findById(sessionId, client = null) {
    const text = `
      SELECT 
        s.id,
        s.user_id,
        s.device_id,
        s.token_hash,
        s.ip_address,
        s.user_agent,
        s.is_revoked,
        s.revoked_at,
        s.revoked_reason,
        s.expires_at,
        s.created_at,
        s.updated_at,
        d.device_name,
        d.device_type,
        d.operating_system,
        d.browser,
        d.last_active_at
      FROM sessions s
      LEFT JOIN user_devices d ON d.id = s.device_id
      WHERE s.id = $1;
    `;

    return client ? queryOneClient(client, text, [sessionId]) : queryOne(text, [sessionId]);
  }

  /**
   * Localiza sessão pelo hash do token de autenticação.
   *
   * @param {string} tokenHash
   * @param {import('pg').PoolClient} [client]
   */
  async findByTokenHash(tokenHash, client = null) {
    const text = `
      SELECT 
        id,
        user_id,
        device_id,
        token_hash,
        ip_address,
        user_agent,
        is_revoked,
        revoked_at,
        revoked_reason,
        expires_at,
        created_at
      FROM sessions
      WHERE token_hash = $1;
    `;

    return client ? queryOneClient(client, text, [tokenHash]) : queryOne(text, [tokenHash]);
  }

  /**
   * Lista todas as sessões ativas (não revogadas e não expiradas) de um utilizador.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   */
  async listActiveSessions(userId, client = null) {
    const text = `
      SELECT 
        s.id,
        s.user_id,
        s.device_id,
        s.ip_address,
        s.user_agent,
        s.created_at,
        s.expires_at,
        d.device_name,
        d.device_type,
        d.operating_system,
        d.browser,
        d.last_active_at
      FROM sessions s
      LEFT JOIN user_devices d ON d.id = s.device_id
      WHERE s.user_id = $1
        AND s.is_revoked = FALSE
        AND s.expires_at > (NOW() AT TIME ZONE 'UTC')
      ORDER BY s.created_at DESC;
    `;

    const result = client ? await queryClient(client, text, [userId]) : await query(text, [userId]);
    return result.rows;
  }

  /**
   * Revoga formalmente uma sessão individual informando a justificativa.
   *
   * @param {string} sessionId
   * @param {string} reason
   * @param {import('pg').PoolClient} [client]
   */
  async revokeSession(sessionId, reason = 'USER_LOGOUT', client = null) {
    const text = `
      UPDATE sessions
      SET is_revoked = TRUE,
          revoked_at = NOW() AT TIME ZONE 'UTC',
          revoked_reason = $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2
      RETURNING id, user_id, is_revoked, revoked_at, revoked_reason;
    `;

    return client ? queryOneClient(client, text, [reason, sessionId]) : queryOne(text, [reason, sessionId]);
  }

  /**
   * Revoga todas as sessões ativas do utilizador exceto a sessão atual (ex: "Terminar noutros dispositivos").
   *
   * @param {string} userId
   * @param {string} currentSessionId
   * @param {string} reason
   * @param {import('pg').PoolClient} [client]
   */
  async revokeOtherSessions(userId, currentSessionId, reason = 'REVOKED_OTHER_SESSIONS', client = null) {
    const text = `
      UPDATE sessions
      SET is_revoked = TRUE,
          revoked_at = NOW() AT TIME ZONE 'UTC',
          revoked_reason = $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE user_id = $2
        AND id <> $3
        AND is_revoked = FALSE;
    `;

    const params = [reason, userId, currentSessionId];
    const result = client ? await queryClient(client, text, params) : await query(text, params);
    return result.rowCount;
  }

  /**
   * Revoga todas as sessões ativas de um utilizador sem exceção.
   *
   * @param {string} userId
   * @param {string} reason
   * @param {import('pg').PoolClient} [client]
   */
  async revokeAllSessions(userId, reason = 'REVOKE_ALL', client = null) {
    const text = `
      UPDATE sessions
      SET is_revoked = TRUE,
          revoked_at = NOW() AT TIME ZONE 'UTC',
          revoked_reason = $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE user_id = $2
        AND is_revoked = FALSE;
    `;

    const result = client ? await queryClient(client, text, [reason, userId]) : await query(text, [reason, userId]);
    return result.rowCount;
  }

  /**
   * Conta a quantidade de sessões concorrentes ativas de um utilizador.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   */
  async countActiveSessions(userId, client = null) {
    const text = `
      SELECT COUNT(*)::integer AS active_count
      FROM sessions
      WHERE user_id = $1
        AND is_revoked = FALSE
        AND expires_at > (NOW() AT TIME ZONE 'UTC');
    `;

    const result = client ? await queryOneClient(client, text, [userId]) : await queryOne(text, [userId]);
    return result ? result.active_count : 0;
  }
}

// Instância singleton do repositório de sessões
const sessionsRepository = new SessionsRepository();

module.exports = sessionsRepository;