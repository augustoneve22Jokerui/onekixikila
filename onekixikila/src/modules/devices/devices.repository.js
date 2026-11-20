const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de acesso a dados SQL para a tabela `user_devices`.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para registo de aparelhos,
 * atualização de tokens de notificação push, marcação de confiabilidade e rastreio de atividade.
 */
class DevicesRepository {
  /**
   * Regista um novo dispositivo ou atualiza o último acesso e metadados de um aparelho já reconhecido.
   *
   * @param {object} params
   * @param {string} params.userId - UUID do utilizador
   * @param {string} params.deviceFingerprint - Impressão digital única do cliente
   * @param {string} [params.deviceName] - Nome amigável (ex: "Samsung Galaxy A54", "iPhone 13")
   * @param {string} [params.deviceType='OTHER'] - 'MOBILE', 'DESKTOP', 'TABLET', 'OTHER'
   * @param {string} [params.operatingSystem='UNKNOWN']
   * @param {string} [params.browser='UNKNOWN']
   * @param {string} [params.pushToken]
   * @param {string} [params.lastIpAddress]
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>} Registo do dispositivo
   */
  async upsertDevice(params, client = null) {
    const {
      userId,
      deviceFingerprint,
      deviceName = 'Dispositivo Não Identificado',
      deviceType = 'OTHER',
      operatingSystem = 'UNKNOWN',
      browser = 'UNKNOWN',
      pushToken = null,
      lastIpAddress = null
    } = params;

    const text = `
      INSERT INTO user_devices (
        user_id,
        device_fingerprint,
        device_name,
        device_type,
        operating_system,
        browser,
        push_token,
        last_ip_address,
        last_active_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() AT TIME ZONE 'UTC')
      ON CONFLICT (user_id, device_fingerprint)
      DO UPDATE SET
        device_name = COALESCE(EXCLUDED.device_name, user_devices.device_name),
        device_type = COALESCE(EXCLUDED.device_type, user_devices.device_type),
        operating_system = COALESCE(EXCLUDED.operating_system, user_devices.operating_system),
        browser = COALESCE(EXCLUDED.browser, user_devices.browser),
        push_token = COALESCE(EXCLUDED.push_token, user_devices.push_token),
        last_ip_address = COALESCE(EXCLUDED.last_ip_address, user_devices.last_ip_address),
        last_active_at = NOW() AT TIME ZONE 'UTC',
        updated_at = NOW() AT TIME ZONE 'UTC'
      RETURNING *;
    `;

    const values = [
      userId,
      deviceFingerprint,
      deviceName,
      deviceType,
      operatingSystem,
      browser,
      pushToken,
      lastIpAddress
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza um dispositivo pelo seu identificador UUID primário.
   *
   * @param {string} deviceId
   * @param {import('pg').PoolClient} [client]
   */
  async findById(deviceId, client = null) {
    const text = `
      SELECT 
        id,
        user_id,
        device_fingerprint,
        device_name,
        device_type,
        operating_system,
        browser,
        push_token,
        is_trusted,
        last_ip_address,
        last_active_at,
        created_at,
        updated_at
      FROM user_devices
      WHERE id = $1;
    `;

    return client ? queryOneClient(client, text, [deviceId]) : queryOne(text, [deviceId]);
  }

  /**
   * Localiza um dispositivo combinando o utilizador e a impressão digital.
   *
   * @param {string} userId
   * @param {string} deviceFingerprint
   * @param {import('pg').PoolClient} [client]
   */
  async findByUserAndFingerprint(userId, deviceFingerprint, client = null) {
    const text = `
      SELECT 
        id,
        user_id,
        device_fingerprint,
        device_name,
        device_type,
        operating_system,
        browser,
        push_token,
        is_trusted,
        last_ip_address,
        last_active_at,
        created_at
      FROM user_devices
      WHERE user_id = $1 AND device_fingerprint = $2;
    `;

    return client ? queryOneClient(client, text, [userId, deviceFingerprint]) : queryOne(text, [userId, deviceFingerprint]);
  }

  /**
   * Lista todos os aparelhos vinculados à conta de um utilizador.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   */
  async listUserDevices(userId, client = null) {
    const text = `
      SELECT 
        id,
        user_id,
        device_fingerprint,
        device_name,
        device_type,
        operating_system,
        browser,
        push_token,
        is_trusted,
        last_ip_address,
        last_active_at,
        created_at
      FROM user_devices
      WHERE user_id = $1
      ORDER BY last_active_at DESC;
    `;

    const result = client ? await queryClient(client, text, [userId]) : await query(text, [userId]);
    return result.rows;
  }

  /**
   * Atualiza o token de notificação push móvel (FCM/APNS) do dispositivo.
   *
   * @param {string} deviceId
   * @param {string} pushToken
   * @param {import('pg').PoolClient} [client]
   */
  async updatePushToken(deviceId, pushToken, client = null) {
    const text = `
      UPDATE user_devices
      SET push_token = $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2
      RETURNING id, push_token, updated_at;
    `;

    return client ? queryOneClient(client, text, [pushToken, deviceId]) : queryOne(text, [pushToken, deviceId]);
  }

  /**
   * Marca o dispositivo como confiável (Trusted Device) ou remove essa classificação.
   *
   * @param {string} deviceId
   * @param {boolean} isTrusted
   * @param {import('pg').PoolClient} [client]
   */
  async updateTrustStatus(deviceId, isTrusted, client = null) {
    const text = `
      UPDATE user_devices
      SET is_trusted = $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2
      RETURNING id, is_trusted, updated_at;
    `;

    return client ? queryOneClient(client, text, [isTrusted, deviceId]) : queryOne(text, [isTrusted, deviceId]);
  }

  /**
   * Atualiza o carimbo de data/hora de última atividade do dispositivo e IP de origem.
   *
   * @param {string} deviceId
   * @param {string} ipAddress
   * @param {import('pg').PoolClient} [client]
   */
  async touchActivity(deviceId, ipAddress, client = null) {
    const text = `
      UPDATE user_devices
      SET last_active_at = NOW() AT TIME ZONE 'UTC',
          last_ip_address = $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2;
    `;

    const params = [ipAddress, deviceId];
    return client ? queryClient(client, text, params) : query(text, params);
  }

  /**
   * Remove permanentemente o registo de um dispositivo da conta.
   *
   * @param {string} deviceId
   * @param {import('pg').PoolClient} [client]
   */
  async deleteDevice(deviceId, client = null) {
    const text = `
      DELETE FROM user_devices
      WHERE id = $1
      RETURNING id, user_id, device_name;
    `;

    return client ? queryOneClient(client, text, [deviceId]) : queryOne(text, [deviceId]);
  }

  /**
   * Conta a quantidade total de dispositivos cadastrados para um utilizador.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   */
  async countDevices(userId, client = null) {
    const text = `
      SELECT COUNT(*)::integer AS total_count
      FROM user_devices
      WHERE user_id = $1;
    `;

    const result = client ? await queryOneClient(client, text, [userId]) : await queryOne(text, [userId]);
    return result ? result.total_count : 0;
  }
}

// Instância singleton do repositório de dispositivos
const devicesRepository = new DevicesRepository();

module.exports = devicesRepository;