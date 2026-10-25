const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência para o módulo de Autenticação, Utilizadores e Sessões.
 * Executa consultas SQL diretas parametrizadas no Neon PostgreSQL para gestão de credenciais,
 * perfis, códigos OTP, dispositivos reconhecidos e sessões revogáveis.
 */
class AuthRepository {
  /**
   * Cria atomicamente o utilizador, o seu perfil inicial, contactos de validação,
   * a carteira digital em Kwanzas (AOA) e a respetiva conta no plano de contas do livro-razão.
   *
   * @param {object} params
   * @param {string} params.email
   * @param {string} params.phoneNumber
   * @param {string} params.passwordHash
   * @param {string} params.fullName
   * @param {string} [params.alternatePhone]
   * @param {string} [params.termsVersion='1.0']
   * @param {import('pg').PoolClient} client - Cliente transacional obrigatório
   * @returns {Promise<{ id: string, email: string, phone_number: string, role: string, status: string }>}
   */
  async createUserWithProfileAndWallet(params, client) {
    const {
      email,
      phoneNumber,
      passwordHash,
      fullName,
      alternatePhone = null,
      termsVersion = '1.0'
    } = params;

    // 1. Inserção na tabela users
    const userInsertSql = `
      INSERT INTO users (
        email,
        phone_number,
        password_hash,
        role,
        status,
        is_email_verified,
        is_phone_verified,
        terms_accepted_at,
        terms_version
      )
      VALUES ($1, $2, $3, 'USER', 'PENDING_VERIFICATION', FALSE, FALSE, NOW() AT TIME ZONE 'UTC', $4)
      RETURNING id, email, phone_number, role, status, created_at;
    `;
    const user = await queryOneClient(client, userInsertSql, [
      email,
      phoneNumber,
      passwordHash,
      termsVersion
    ]);

    // 2. Inserção do perfil correspondente em user_profiles
    const profileInsertSql = `
      INSERT INTO user_profiles (
        user_id,
        full_name,
        preferred_name,
        country,
        preferred_locale,
        preferred_currency,
        notification_preferences
      )
      VALUES ($1, $2, $2, 'AGO', 'pt-AO', 'AOA', '{"email": true, "sms": true, "in_app": true}'::jsonb)
      RETURNING id;
    `;
    await queryClient(client, profileInsertSql, [user.id, fullName]);

    // 3. Registo dos contactos primários em user_contacts
    const phoneContactSql = `
      INSERT INTO user_contacts (user_id, contact_type, contact_value, is_verified, is_primary)
      VALUES ($1, 'PHONE_PRIMARY', $2, FALSE, TRUE);
    `;
    await queryClient(client, phoneContactSql, [user.id, phoneNumber]);

    const emailContactSql = `
      INSERT INTO user_contacts (user_id, contact_type, contact_value, is_verified, is_primary)
      VALUES ($1, 'EMAIL_PRIMARY', $2, FALSE, TRUE);
    `;
    await queryClient(client, emailContactSql, [user.id, email]);

    if (alternatePhone) {
      const altPhoneSql = `
        INSERT INTO user_contacts (user_id, contact_type, contact_value, is_verified, is_primary)
        VALUES ($1, 'PHONE_SECONDARY', $2, FALSE, FALSE);
      `;
      await queryClient(client, altPhoneSql, [user.id, alternatePhone]);
    }

    // 4. Criação da carteira interna do utilizador em Kwanzas
    const walletInsertSql = `
      INSERT INTO wallets (user_id, currency, status, ledger_balance, available_balance, locked_balance)
      VALUES ($1, 'AOA', 'ACTIVE', 0, 0, 0)
      RETURNING id;
    `;
    const wallet = await queryOneClient(client, walletInsertSql, [user.id]);

    // 5. Criação da conta pessoal de Passivo Exigível no livro-razão contábil
    const personalAccountCode = `2001-USER-${user.id.slice(0, 8).toUpperCase()}`;
    const ledgerAccountSql = `
      INSERT INTO ledger_accounts (
        account_code,
        name,
        account_type,
        currency,
        is_system,
        user_id,
        wallet_id,
        balance
      )
      VALUES ($1, $2, 'LIABILITY', 'AOA', FALSE, $3, $4, 0);
    `;
    await queryClient(client, ledgerAccountSql, [
      personalAccountCode,
      `Carteira de ${fullName}`,
      user.id,
      wallet.id
    ]);

    return user;
  }

  /**
   * Localiza utilizador por endereço de e-mail (insensível a maiúsculas via CITEXT).
   *
   * @param {string} email
   * @param {import('pg').PoolClient} [client]
   */
  async findByEmail(email, client = null) {
    const text = `
      SELECT 
        u.id,
        u.email,
        u.phone_number,
        u.password_hash,
        u.role,
        u.status,
        u.is_email_verified,
        u.is_phone_verified,
        u.failed_login_attempts,
        u.locked_until,
        u.last_login_at,
        p.full_name,
        p.preferred_name
      FROM users u
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.email = $1 AND u.deleted_at IS NULL;
    `;
    return client ? queryOneClient(client, text, [email]) : queryOne(text, [email]);
  }

  /**
   * Localiza utilizador por número de telemóvel.
   *
   * @param {string} phone
   * @param {import('pg').PoolClient} [client]
   */
  async findByPhone(phone, client = null) {
    const text = `
      SELECT 
        u.id,
        u.email,
        u.phone_number,
        u.password_hash,
        u.role,
        u.status,
        u.is_email_verified,
        u.is_phone_verified,
        u.failed_login_attempts,
        u.locked_until,
        u.last_login_at,
        p.full_name,
        p.preferred_name
      FROM users u
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.phone_number = $1 AND u.deleted_at IS NULL;
    `;
    return client ? queryOneClient(client, text, [phone]) : queryOne(text, [phone]);
  }

  /**
   * Localiza utilizador por identificador único (e-mail ou número de telemóvel).
   *
   * @param {string} identifier
   * @param {import('pg').PoolClient} [client]
   */
  async findByIdentifier(identifier, client = null) {
    const text = `
      SELECT 
        u.id,
        u.email,
        u.phone_number,
        u.password_hash,
        u.role,
        u.status,
        u.is_email_verified,
        u.is_phone_verified,
        u.failed_login_attempts,
        u.locked_until,
        u.last_login_at,
        p.full_name,
        p.preferred_name
      FROM users u
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE (u.email = $1 OR u.phone_number = $1)
        AND u.deleted_at IS NULL;
    `;
    return client ? queryOneClient(client, text, [identifier]) : queryOne(text, [identifier]);
  }

  /**
   * Localiza utilizador pelo seu UUID.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
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
        u.failed_login_attempts,
        u.locked_until,
        u.last_login_at,
        p.full_name,
        p.preferred_name,
        p.country,
        p.province,
        p.municipality
      FROM users u
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL;
    `;
    return client ? queryOneClient(client, text, [userId]) : queryOne(text, [userId]);
  }

  /**
   * Atualiza as tentativas falhadas de autenticação e bloqueia temporariamente a conta se exceder o limite.
   *
   * @param {string} userId
   * @param {number} attempts
   * @param {Date|null} lockedUntil
   * @param {import('pg').PoolClient} [client]
   */
  async updateFailedLoginAttempts(userId, attempts, lockedUntil = null, client = null) {
    const text = `
      UPDATE users
      SET failed_login_attempts = $1,
          locked_until = $2,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $3;
    `;
    const params = [attempts, lockedUntil, userId];
    return client ? queryClient(client, text, params) : query(text, params);
  }

  /**
   * Redefine o contador de tentativas falhadas e remove qualquer bloqueio temporário após login bem-sucedido.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   */
  async resetFailedLoginAttempts(userId, client = null) {
    const text = `
      UPDATE users
      SET failed_login_attempts = 0,
          locked_until = NULL,
          last_login_at = NOW() AT TIME ZONE 'UTC',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $1;
    `;
    return client ? queryClient(client, text, [userId]) : query(text, [userId]);
  }

  /**
   * Atualiza a palavra-passe do utilizador e limpa eventuais bloqueios.
   *
   * @param {string} userId
   * @param {string} passwordHash
   * @param {import('pg').PoolClient} [client]
   */
  async updatePassword(userId, passwordHash, client = null) {
    const text = `
      UPDATE users
      SET password_hash = $1,
          failed_login_attempts = 0,
          locked_until = NULL,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2;
    `;
    return client ? queryClient(client, text, [passwordHash, userId]) : query(text, [passwordHash, userId]);
  }

  /**
   * Salva o hash do código OTP de verificação para o contacto específico.
   *
   * @param {string} userId
   * @param {string} contactType - 'PHONE_PRIMARY' ou 'EMAIL_PRIMARY'
   * @param {string} codeHash - Hash SHA-256 do código numérico
   * @param {Date} expiresAt
   * @param {import('pg').PoolClient} [client]
   */
  async saveVerificationOtp(userId, contactType, codeHash, expiresAt, client = null) {
    const text = `
      UPDATE user_contacts
      SET verification_code_hash = $1,
          verification_code_expires_at = $2,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE user_id = $3 AND contact_type = $4;
    `;
    const params = [codeHash, expiresAt, userId, contactType];
    return client ? queryClient(client, text, params) : query(text, params);
  }

  /**
   * Consulta os dados do código OTP ativo para verificação.
   *
   * @param {string} userId
   * @param {string} contactType
   * @param {import('pg').PoolClient} [client]
   */
  async getContactVerificationOtp(userId, contactType, client = null) {
    const text = `
      SELECT id, contact_value, verification_code_hash, verification_code_expires_at, is_verified
      FROM user_contacts
      WHERE user_id = $1 AND contact_type = $2;
    `;
    return client ? queryOneClient(client, text, [userId, contactType]) : queryOne(text, [userId, contactType]);
  }

  /**
   * Marca o contacto e a respetiva flag de verificação no utilizador como confirmados.
   *
   * @param {string} userId
   * @param {string} contactType
   * @param {import('pg').PoolClient} [client]
   */
  async confirmContactVerification(userId, contactType, client = null) {
    const isEmail = contactType.includes('EMAIL');
    const updateContactText = `
      UPDATE user_contacts
      SET is_verified = TRUE,
          verified_at = NOW() AT TIME ZONE 'UTC',
          verification_code_hash = NULL,
          verification_code_expires_at = NULL,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE user_id = $1 AND contact_type = $2;
    `;

    const updateUserText = isEmail
      ? `UPDATE users SET is_email_verified = TRUE, email_verified_at = NOW() AT TIME ZONE 'UTC', status = CASE WHEN status = 'PENDING_VERIFICATION' AND is_phone_verified = TRUE THEN 'ACTIVE'::user_status ELSE status END, updated_at = NOW() AT TIME ZONE 'UTC' WHERE id = $1;`
      : `UPDATE users SET is_phone_verified = TRUE, phone_verified_at = NOW() AT TIME ZONE 'UTC', status = CASE WHEN status = 'PENDING_VERIFICATION' AND is_email_verified = TRUE THEN 'ACTIVE'::user_status ELSE status END, updated_at = NOW() AT TIME ZONE 'UTC' WHERE id = $1;`;

    if (client) {
      await queryClient(client, updateContactText, [userId, contactType]);
      await queryClient(client, updateUserText, [userId]);
    } else {
      await query(updateContactText, [userId, contactType]);
      await query(updateUserText, [userId]);
    }
  }

  /**
   * Regista ou atualiza o dispositivo do utilizador na tabela user_devices.
   *
   * @param {object} params
   * @param {import('pg').PoolClient} [client]
   */
  async upsertDevice(params, client = null) {
    const {
      userId,
      deviceFingerprint,
      deviceName,
      deviceType,
      ipAddress,
      operatingSystem = 'UNKNOWN',
      browser = 'UNKNOWN'
    } = params;

    const text = `
      INSERT INTO user_devices (
        user_id,
        device_fingerprint,
        device_name,
        device_type,
        operating_system,
        browser,
        last_ip_address,
        last_active_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() AT TIME ZONE 'UTC')
      ON CONFLICT (user_id, device_fingerprint)
      DO UPDATE SET
        device_name = EXCLUDED.device_name,
        device_type = EXCLUDED.device_type,
        last_ip_address = EXCLUDED.last_ip_address,
        last_active_at = NOW() AT TIME ZONE 'UTC',
        updated_at = NOW() AT TIME ZONE 'UTC'
      RETURNING id;
    `;

    const values = [userId, deviceFingerprint, deviceName, deviceType, operatingSystem, browser, ipAddress];
    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Regista uma nova sessão revogável associada ao token na tabela sessions.
   *
   * @param {object} params
   * @param {import('pg').PoolClient} [client]
   */
  async createSession(params, client = null) {
    const { userId, deviceId, tokenHash, ipAddress, userAgent, expiresAt } = params;

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
      RETURNING id;
    `;

    const values = [userId, deviceId || null, tokenHash, ipAddress, userAgent, expiresAt];
    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Consulta sessão ativa por hash de token.
   *
   * @param {string} tokenHash
   * @param {import('pg').PoolClient} [client]
   */
  async findSessionByTokenHash(tokenHash, client = null) {
    const text = `
      SELECT id, user_id, device_id, is_revoked, expires_at
      FROM sessions
      WHERE token_hash = $1;
    `;
    return client ? queryOneClient(client, text, [tokenHash]) : queryOne(text, [tokenHash]);
  }

  /**
   * Revoga formalmente uma sessão individual.
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
      WHERE id = $2;
    `;
    return client ? queryClient(client, text, [reason, sessionId]) : query(text, [reason, sessionId]);
  }

  /**
   * Revoga todas as sessões ativas de um utilizador (ex: após alteração de palavra-passe).
   *
   * @param {string} userId
   * @param {string} reason
   * @param {import('pg').PoolClient} [client]
   */
  async revokeAllUserSessions(userId, reason = 'PASSWORD_CHANGED', client = null) {
    const text = `
      UPDATE sessions
      SET is_revoked = TRUE,
          revoked_at = NOW() AT TIME ZONE 'UTC',
          revoked_reason = $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE user_id = $2 AND is_revoked = FALSE;
    `;
    return client ? queryClient(client, text, [reason, userId]) : query(text, [reason, userId]);
  }
}

// Instância singleton do repositório de autenticação
const authRepository = new AuthRepository();

module.exports = authRepository;