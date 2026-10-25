const authRepository = require('./auth.repository');
const authPolicy = require('./auth.policy');
const passwordSecurity = require('../../shared/security/password');
const tokenSecurity = require('../../shared/security/tokens');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const { withTransaction } = require('../../database/transaction');
const ConflictError = require('../../shared/errors/conflict-error');
const AuthenticationError = require('../../shared/errors/authentication-error');
const ValidationError = require('../../shared/errors/validation-error');
const NotFoundError = require('../../shared/errors/not-found-error');

/**
 * Serviço orquestrador de regras de negócio para Autenticação, Contas e Credenciais
 * na plataforma OneKixikila.
 */
class AuthService {
  /**
   * Executa o registo de um novo utilizador na plataforma.
   * Cria atomicamente a conta, perfil, contactos, carteira digital em AOA,
   * emite os códigos OTP de validação e dispara os eventos de boas-vindas.
   *
   * @param {object} registrationData
   * @param {object} [context={}]
   * @returns {Promise<{ user: object, message: string }>}
   */
  async register(registrationData, context = {}) {
    const { email, phoneNumber, password, fullName, alternatePhone } = registrationData;

    // 1. Verificação de conflito prévio por e-mail
    const existingByEmail = await authRepository.findByEmail(email);
    if (existingByEmail) {
      throw ConflictError.duplicate('Utilizador', 'email');
    }

    // 2. Verificação de conflito prévio por número de telemóvel
    const existingByPhone = await authRepository.findByPhone(phoneNumber);
    if (existingByPhone) {
      throw ConflictError.duplicate('Utilizador', 'phone_number');
    }

    // 3. Criptografia segura da palavra-passe com Argon2id
    const passwordHash = await passwordSecurity.hashPassword(password);

    // 4. Execução transacional atómica na base de dados Neon PostgreSQL
    const createdUser = await withTransaction(async (client) => {
      const user = await authRepository.createUserWithProfileAndWallet(
        {
          email,
          phoneNumber,
          passwordHash,
          fullName,
          alternatePhone
        },
        client
      );

      // Gera código OTP numérico para confirmação do telemóvel
      const phoneOtp = tokenSecurity.generateNumericOtp(6);
      await authRepository.saveVerificationOtp(
        user.id,
        'PHONE_PRIMARY',
        phoneOtp.codeHash,
        phoneOtp.expiresAt,
        client
      );

      // Gera código OTP para confirmação do e-mail
      const emailOtp = tokenSecurity.generateNumericOtp(6);
      await authRepository.saveVerificationOtp(
        user.id,
        'EMAIL_PRIMARY',
        emailOtp.codeHash,
        emailOtp.expiresAt,
        client
      );

      // Publica evento assíncrono de registo com os dados para despacho de SMS/E-mail
      eventBus.publish(
        EVENT_TYPES.AUTH_USER_REGISTERED,
        {
          userId: user.id,
          fullName,
          email: user.email,
          phoneNumber: user.phone_number,
          phoneOtpCode: phoneOtp.code,
          emailOtpCode: emailOtp.code
        },
        { requestId: context.requestId }
      );

      return user;
    });

    return {
      user: {
        id: createdUser.id,
        email: createdUser.email,
        phoneNumber: createdUser.phone_number,
        role: createdUser.role,
        status: createdUser.status
      },
      message: 'Conta criada com sucesso. Verifique o seu telemóvel e e-mail para ativar a conta.'
    };
  }

  /**
   * Autentica o utilizador por e-mail ou telemóvel e emite os tokens de sessão.
   *
   * @param {object} credentials
   * @param {string} credentials.identifier - E-mail ou número de telefone
   * @param {string} credentials.password - Palavra-passe
   * @param {string} [credentials.deviceFingerprint]
   * @param {string} [credentials.deviceName]
   * @param {string} [credentials.deviceType]
   * @param {string} [credentials.ipAddress]
   * @param {string} [credentials.userAgent]
   * @param {object} [context={}]
   * @returns {Promise<{ accessToken: string, refreshToken: string, user: object, session: object }>}
   */
  async login(credentials, context = {}) {
    const {
      identifier,
      password,
      deviceFingerprint = 'unknown-device',
      deviceName = 'Navegador Web',
      deviceType = 'OTHER',
      ipAddress = '127.0.0.1',
      userAgent = 'UNKNOWN'
    } = credentials;

    // 1. Busca utilizador pelo identificador único (e-mail ou telefone)
    const user = await authRepository.findByIdentifier(identifier);

    // Proteção contra enumeração de contas e ataques de temporização
    if (!user) {
      throw AuthenticationError.invalidCredentials();
    }

    // 2. Avaliação das políticas de acesso e bloqueio temporário por força bruta
    const policyResult = authPolicy.canAttemptLogin(user);
    if (!policyResult.allowed) {
      const error = new AuthenticationError(policyResult.reason, 'ACCOUNT_LOGIN_BLOCKED');
      error.statusCode = policyResult.statusCode || 403;
      error.status = error.statusCode;
      throw error;
    }

    // 3. Verificação do hash da palavra-passe com Argon2id
    const isPasswordValid = await passwordSecurity.verifyPassword(user.password_hash, password);

    if (!isPasswordValid) {
      // Regista falha e aplica bloqueio temporário se exceder o teto
      const evalResult = authPolicy.evaluateFailedLoginAttempt(user.failed_login_attempts);
      await authRepository.updateFailedLoginAttempts(
        user.id,
        evalResult.nextAttempts,
        evalResult.lockedUntil
      );

      eventBus.publish(
        EVENT_TYPES.AUTH_LOGIN_FAILED,
        {
          userId: user.id,
          identifier,
          ipAddress,
          attempts: evalResult.nextAttempts,
          lockedUntil: evalResult.lockedUntil
        },
        { requestId: context.requestId }
      );

      throw AuthenticationError.invalidCredentials();
    }

    // 4. Redefine o contador de falhas após sucesso
    await authRepository.resetFailedLoginAttempts(user.id);

    // 5. Registo / Atualização do dispositivo reconhecido
    const device = await authRepository.upsertDevice({
      userId: user.id,
      deviceFingerprint,
      deviceName,
      deviceType,
      ipAddress
    });

    // 6. Geração dos tokens criptográficos
    const refreshToken = tokenSecurity.generateRefreshToken();
    const tokenHash = tokenSecurity.hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 dias

    // 7. Criação da sessão revogável no PostgreSQL
    const session = await authRepository.createSession({
      userId: user.id,
      deviceId: device ? device.id : null,
      tokenHash,
      ipAddress,
      userAgent,
      expiresAt
    });

    // 8. Emissão do Access Token JWT assinado com claims de sessão
    const accessToken = tokenSecurity.generateAccessToken({
      userId: user.id,
      role: user.role,
      sessionId: session.id
    });

    eventBus.publish(
      EVENT_TYPES.AUTH_LOGIN_SUCCESS,
      {
        userId: user.id,
        sessionId: session.id,
        ipAddress,
        userAgent
      },
      { requestId: context.requestId }
    );

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        phoneNumber: user.phone_number,
        role: user.role,
        status: user.status,
        fullName: user.full_name,
        preferredName: user.preferred_name,
        isEmailVerified: user.is_email_verified,
        isPhoneVerified: user.is_phone_verified
      },
      session: {
        id: session.id,
        expiresAt: expiresAt.toISOString()
      }
    };
  }

  /**
   * Confirmação de conta ou contacto via código OTP numérico.
   *
   * @param {object} params
   * @param {string} params.type - 'PHONE' ou 'EMAIL'
   * @param {string} params.code - Código numérico de 4 a 8 dígitos
   * @param {string} [params.userId] - Identificador do utilizador (se já conhecido)
   * @param {string} [params.identifier] - E-mail ou telefone de referência
   * @returns {Promise<{ message: string, isVerified: boolean }>}
   */
  async verifyOtp(params) {
    const { type, code, userId: explicitUserId, identifier } = params;

    let targetUserId = explicitUserId;

    if (!targetUserId && identifier) {
      const user = await authRepository.findByIdentifier(identifier);
      if (user) {
        targetUserId = user.id;
      }
    }

    if (!targetUserId) {
      throw new ValidationError('Utilizador não identificado para validação do código OTP.');
    }

    const contactType = type === 'EMAIL' ? 'EMAIL_PRIMARY' : 'PHONE_PRIMARY';
    const contactRecord = await authRepository.getContactVerificationOtp(targetUserId, contactType);

    // Validação da política de carência temporal do código
    const policyResult = authPolicy.canVerifyOtp(contactRecord);
    if (!policyResult.valid) {
      throw new ValidationError(policyResult.reason);
    }

    // Verificação em tempo constante do hash do código
    const isCodeMatch = tokenSecurity.verifyTokenHash(code, contactRecord.verification_code_hash);
    if (!isCodeMatch) {
      throw new ValidationError('O código de validação inserido é incorreto.');
    }

    // Confirmação formal e ativação da conta
    await authRepository.confirmContactVerification(targetUserId, contactType);

    eventBus.publish(
      type === 'EMAIL' ? EVENT_TYPES.AUTH_EMAIL_VERIFIED : EVENT_TYPES.AUTH_PHONE_VERIFIED,
      {
        userId: targetUserId,
        contactType
      }
    );

    return {
      message: `${type === 'EMAIL' ? 'Endereço de e-mail' : 'Número de telemóvel'} verificado com sucesso.`,
      isVerified: true
    };
  }

  /**
   * Reenvio de código OTP numérico para o canal solicitado.
   * Resposta padronizada para prevenir enumeração de contas.
   *
   * @param {object} params
   * @param {'PHONE'|'EMAIL'} params.type
   * @param {string} params.identifier
   * @returns {Promise<{ message: string }>}
   */
  async resendOtp({ type, identifier }) {
    const user = await authRepository.findByIdentifier(identifier);

    if (user) {
      const contactType = type === 'EMAIL' ? 'EMAIL_PRIMARY' : 'PHONE_PRIMARY';
      const otp = tokenSecurity.generateNumericOtp(6);

      await authRepository.saveVerificationOtp(user.id, contactType, otp.codeHash, otp.expiresAt);

      eventBus.publish(
        type === 'EMAIL' ? EVENT_TYPES.AUTH_EMAIL_VERIFIED : EVENT_TYPES.AUTH_PHONE_VERIFIED,
        {
          userId: user.id,
          identifier,
          otpCode: otp.code
        }
      );
    }

    return {
      message: 'Se os dados informados corresponderem a uma conta registada, um novo código foi enviado.'
    };
  }

  /**
   * Solicitação de recuperação de conta (Esquecimento de senha).
   * Resposta uniforme sem revelar se o contacto está cadastrado.
   *
   * @param {string} identifier
   * @returns {Promise<{ message: string }>}
   */
  async forgotPassword(identifier) {
    const user = await authRepository.findByIdentifier(identifier);

    if (user && user.status !== 'BLOCKED' && user.status !== 'DEACTIVATED') {
      const resetTokenData = tokenSecurity.generatePasswordResetToken();

      // Guarda o token de recuperação temporário nos contactos para validação posterior
      await authRepository.saveVerificationOtp(
        user.id,
        'EMAIL_PRIMARY',
        resetTokenData.tokenHash,
        resetTokenData.expiresAt
      );

      eventBus.publish(EVENT_TYPES.AUTH_PASSWORD_RESET_REQUESTED, {
        userId: user.id,
        email: user.email,
        phoneNumber: user.phone_number,
        resetToken: resetTokenData.token
      });
    }

    return {
      message: 'Se o contacto informado pertencer a uma conta ativa, as instruções de redefinição foram enviadas.'
    };
  }

  /**
   * Redefinição de palavra-passe através de token de recuperação.
   *
   * @param {object} params
   * @param {string} params.token
   * @param {string} params.newPassword
   * @returns {Promise<{ message: string }>}
   */
  async resetPassword({ token, newPassword }) {
    const tokenHash = tokenSecurity.hashToken(token);

    // Consulta se existe registo ativo com este token
    const contactSql = `
      SELECT user_id, verification_code_expires_at
      FROM user_contacts
      WHERE verification_code_hash = $1
        AND verification_code_expires_at > (NOW() AT TIME ZONE 'UTC')
      LIMIT 1;
    `;
    const { queryOne } = require('../../database/query');
    const contactRecord = await queryOne(contactSql, [tokenHash]);

    if (!contactRecord) {
      throw new ValidationError('O link ou token de redefinição de palavra-passe é inválido ou expirou.');
    }

    const userId = contactRecord.user_id;
    const passwordHash = await passwordSecurity.hashPassword(newPassword);

    await withTransaction(async (client) => {
      // 1. Atualiza a palavra-passe
      await authRepository.updatePassword(userId, passwordHash, client);

      // 2. Invalida o token de recuperação
      await client.query(
        `UPDATE user_contacts
         SET verification_code_hash = NULL,
             verification_code_expires_at = NULL,
             updated_at = NOW() AT TIME ZONE 'UTC'
         WHERE user_id = $1;`,
        [userId]
      );

      // 3. Revoga todas as sessões ativas do utilizador por segurança
      await authRepository.revokeAllUserSessions(userId, 'PASSWORD_RESET', client);
    });

    eventBus.publish(EVENT_TYPES.AUTH_PASSWORD_CHANGED, { userId });

    return {
      message: 'A sua palavra-passe foi redefinida com sucesso. Pode agora iniciar sessão com a nova credencial.'
    };
  }

  /**
   * Alteração de palavra-passe solicitada por utilizador com sessão iniciada.
   *
   * @param {string} userId
   * @param {object} params
   * @param {string} params.currentPassword
   * @param {string} params.newPassword
   * @returns {Promise<{ message: string }>}
   */
  async changePassword(userId, { currentPassword, newPassword }) {
    const user = await authRepository.findById(userId);
    if (!user) {
      throw NotFoundError.user(userId);
    }

    // Busca o hash atual da senha
    const fullUser = await authRepository.findByEmail(user.email);
    const isCurrentValid = await passwordSecurity.verifyPassword(fullUser.password_hash, currentPassword);

    if (!isCurrentValid) {
      throw new AuthenticationError('A palavra-passe atual inserida está incorreta.', 'INVALID_CURRENT_PASSWORD');
    }

    const newPasswordHash = await passwordSecurity.hashPassword(newPassword);

    await withTransaction(async (client) => {
      await authRepository.updatePassword(userId, newPasswordHash, client);
      await authRepository.revokeAllUserSessions(userId, 'PASSWORD_CHANGED', client);
    });

    eventBus.publish(EVENT_TYPES.AUTH_PASSWORD_CHANGED, { userId });

    return {
      message: 'A sua palavra-passe foi alterada com sucesso. Todas as outras sessões foram encerradas.'
    };
  }

  /**
   * Renovação de Access Token e rotação de Refresh Token.
   *
   * @param {string} rawRefreshToken
   * @param {object} [clientContext={}]
   * @returns {Promise<{ accessToken: string, refreshToken: string }>}
   */
  async refreshToken(rawRefreshToken, clientContext = {}) {
    const tokenHash = tokenSecurity.hashToken(rawRefreshToken);
    const session = await authRepository.findSessionByTokenHash(tokenHash);

    if (!session || session.is_revoked || new Date(session.expires_at).getTime() < Date.now()) {
      throw AuthenticationError.sessionRevoked();
    }

    const user = await authRepository.findById(session.user_id);
    if (!user || user.status === 'BLOCKED' || user.status === 'DEACTIVATED') {
      throw new AuthenticationError('Conta de utilizador suspensa ou indisponível.', 'ACCOUNT_RESTRICTED');
    }

    // Rotação do Refresh Token para proteção contra repetição
    const newRefreshToken = tokenSecurity.generateRefreshToken();
    const newTokenHash = tokenSecurity.hashToken(newRefreshToken);

    const { query: dbQuery } = require('../../database/query');
    await dbQuery(
      `UPDATE sessions
       SET token_hash = $1,
           last_active_at = NOW() AT TIME ZONE 'UTC',
           updated_at = NOW() AT TIME ZONE 'UTC'
       WHERE id = $2;`,
      [newTokenHash, session.id]
    );

    const newAccessToken = tokenSecurity.generateAccessToken({
      userId: user.id,
      role: user.role,
      sessionId: session.id
    });

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken
    };
  }

  /**
   * Encerramento formal de sessão (Logout).
   *
   * @param {string} sessionId
   * @param {string} [userId]
   * @param {string} [reason='USER_LOGOUT']
   * @returns {Promise<{ message: string }>}
   */
  async logout(sessionId, userId = null, reason = 'USER_LOGOUT') {
    if (sessionId) {
      await authRepository.revokeSession(sessionId, reason);
      eventBus.publish(EVENT_TYPES.AUTH_SESSION_REVOKED, { sessionId, userId, reason });
    }
    return {
      message: 'Sessão encerrada com sucesso.'
    };
  }
}

// Instância singleton do serviço de autenticação
const authService = new AuthService();

module.exports = authService;