const authRepository = require('./auth.repository');
const authPolicy = require('./auth.policy');
const passwordSecurity = require('../../shared/security/password');
const tokenSecurity = require('../../shared/security/tokens');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const { withTransaction } = require('../../database/transaction');
const { queryOne, queryClient } = require('../../database/query');
const ConflictError = require('../../shared/errors/conflict-error');
const AuthenticationError = require('../../shared/errors/authentication-error');
const ValidationError = require('../../shared/errors/validation-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const logger = require('../../shared/logging/logger');

const serviceLogger = logger.child({ module: 'AUTH_SERVICE' });

// Mapa de tipo público (EMAIL/PHONE) → tipo interno na tabela user_contacts
const CONTACT_TYPE_MAP = Object.freeze({
  EMAIL: 'EMAIL_PRIMARY',
  PHONE: 'PHONE_PRIMARY'
});

/**
 * Resolve o tipo interno de contacto a partir do tipo público.
 * @param {'EMAIL'|'PHONE'} type
 * @returns {'EMAIL_PRIMARY'|'PHONE_PRIMARY'}
 */
const resolveContactType = (type) => CONTACT_TYPE_MAP[type] || CONTACT_TYPE_MAP.PHONE;

/**
 * Serviço orquestrador de regras de negócio para Autenticação, Contas e Credenciais
 * na plataforma OneKixikila.
 *
 * Este serviço devolve os códigos OTP gerados ao controlador, que se encarrega
 * de os enfileirar na tabela `notifications` para envio pelo job dedicado.
 *
 * A validade do OTP é de 10 minutos (600 segundos), configurável em limits.js.
 */
class AuthService {
  /**
   * Executa o registo de um novo utilizador na plataforma.
   */
  async register(registrationData, context = {}) {
    const { email, phoneNumber, password, fullName, alternatePhone } = registrationData;

    const existingByEmail = await authRepository.findByEmail(email);
    if (existingByEmail) {
      throw ConflictError.duplicate('Utilizador', 'email');
    }

    const existingByPhone = await authRepository.findByPhone(phoneNumber);
    if (existingByPhone) {
      throw ConflictError.duplicate('Utilizador', 'phone_number');
    }

    const passwordHash = await passwordSecurity.hashPassword(password);

    const createdUser = await withTransaction(async (client) => {
      const user = await authRepository.createUserWithProfileAndWallet(
        { email, phoneNumber, passwordHash, fullName, alternatePhone },
        client
      );

      const phoneOtp = tokenSecurity.generateNumericOtp(6);
      await authRepository.saveVerificationOtp(
        user.id,
        'PHONE_PRIMARY',
        phoneOtp.codeHash,
        phoneOtp.expiresAt,
        client
      );

      const emailOtp = tokenSecurity.generateNumericOtp(6);
      await authRepository.saveVerificationOtp(
        user.id,
        'EMAIL_PRIMARY',
        emailOtp.codeHash,
        emailOtp.expiresAt,
        client
      );

      eventBus.publish(
        EVENT_TYPES.AUTH_USER_REGISTERED,
        {
          userId: user.id,
          fullName,
          email: user.email,
          phoneNumber: user.phone_number
        },
        { requestId: context.requestId }
      );

      return {
        user,
        phoneOtpCode: phoneOtp.code,
        emailOtpCode: emailOtp.code
      };
    });

    return {
      user: {
        id: createdUser.user.id,
        email: createdUser.user.email,
        phoneNumber: createdUser.user.phone_number,
        role: createdUser.user.role,
        status: createdUser.user.status
      },
      message:
        'Conta criada com sucesso. Verifique o seu telemóvel e e-mail para ativar a conta. O código é válido por 10 minutos.',
      otpCodes: {
        emailOtpCode: createdUser.emailOtpCode,
        phoneOtpCode: createdUser.phoneOtpCode,
        fullName,
        email,
        phoneNumber
      }
    };
  }

  /**
   * Autentica o utilizador por e-mail ou telemóvel e emite os tokens de sessão.
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

    const user = await authRepository.findByIdentifier(identifier);

    if (!user) {
      throw AuthenticationError.invalidCredentials();
    }

    const policyResult = authPolicy.canAttemptLogin(user);
    if (!policyResult.allowed) {
      const error = new AuthenticationError(policyResult.reason, 'ACCOUNT_LOGIN_BLOCKED');
      error.statusCode = policyResult.statusCode || 403;
      error.status = error.statusCode;
      throw error;
    }

    const isPasswordValid = await passwordSecurity.verifyPassword(user.password_hash, password);

    if (!isPasswordValid) {
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

    await authRepository.resetFailedLoginAttempts(user.id);

    const device = await authRepository.upsertDevice({
      userId: user.id,
      deviceFingerprint,
      deviceName,
      deviceType,
      ipAddress
    });

    if (!device) {
      // Não bloqueia o login — apenas regista para diagnóstico.
      serviceLogger.warn(
        `[AUTH:LOGIN] upsertDevice devolveu nulo para userId=${user.id} (fingerprint=${deviceFingerprint}). Sessão prossegue sem dispositivo associado.`
      );
    }

    const refreshToken = tokenSecurity.generateRefreshToken();
    const tokenHash = tokenSecurity.hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const session = await authRepository.createSession({
      userId: user.id,
      deviceId: device ? device.id : null,
      tokenHash,
      ipAddress,
      userAgent,
      expiresAt
    });

    const accessToken = tokenSecurity.generateAccessToken({
      userId: user.id,
      role: user.role,
      sessionId: session.id
    });

    eventBus.publish(
      EVENT_TYPES.AUTH_LOGIN_SUCCESS,
      { userId: user.id, sessionId: session.id, ipAddress, userAgent },
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
   * ⚠️ SEGURANÇA: só aceitamos UMA das duas fontes de identidade:
   *   - `userId` (sessão autenticada, injetado pelo controller a partir de `req.user`);
   *   - OU `identifier` (fluxo público de registo, antes de haver sessão).
   *
   * Se ambos vierem, o `userId` ganha e o `identifier` é ignorado.
   * Isto impede que um atacante passe `userId` de outra conta.
   */
  async verifyOtp(params) {
    const { type, code, userId, identifier } = params;

    if (!userId && !identifier) {
      throw new ValidationError('É necessário identificar a conta para validar o código OTP.');
    }

    let targetUserId = userId || null;

    if (!targetUserId && identifier) {
      const user = await authRepository.findByIdentifier(identifier);
      if (user) targetUserId = user.id;
    }

    if (!targetUserId) {
      throw new ValidationError('Utilizador não identificado para validação do código OTP.');
    }

    const contactType = resolveContactType(type);
    const contactRecord = await authRepository.getContactVerificationOtp(targetUserId, contactType);

    const policyResult = authPolicy.canVerifyOtp(contactRecord);
    if (!policyResult.valid) {
      throw new ValidationError(policyResult.reason);
    }

    const isCodeMatch = tokenSecurity.verifyTokenHash(code, contactRecord.verification_code_hash);
    if (!isCodeMatch) {
      throw new ValidationError('O código de validação inserido é incorreto.');
    }

    await authRepository.confirmContactVerification(targetUserId, contactType);

    eventBus.publish(
      type === 'EMAIL' ? EVENT_TYPES.AUTH_EMAIL_VERIFIED : EVENT_TYPES.AUTH_PHONE_VERIFIED,
      { userId: targetUserId, contactType }
    );

    return {
      message: `${
        type === 'EMAIL' ? 'Endereço de e-mail' : 'Número de telemóvel'
      } verificado com sucesso.`,
      isVerified: true
    };
  }

  /**
   * Reenvio de código OTP numérico para o canal solicitado.
   * O novo código gerado tem validade de 10 minutos.
   */
  async resendOtp({ type, identifier }) {
    const user = await authRepository.findByIdentifier(identifier);

    if (user) {
      const contactType = resolveContactType(type);
      const otp = tokenSecurity.generateNumericOtp(6);

      await authRepository.saveVerificationOtp(user.id, contactType, otp.codeHash, otp.expiresAt);

      // ⚠️ Este evento NÃO é de "verificado" — é de "reenvio de código".
      // Publicar *_VERIFIED aqui marcaria a conta como verificada sem prova.
      const eventType =
        type === 'EMAIL'
          ? EVENT_TYPES.AUTH_EMAIL_VERIFICATION_REQUESTED || 'AUTH_EMAIL_VERIFICATION_REQUESTED'
          : EVENT_TYPES.AUTH_PHONE_VERIFICATION_REQUESTED || 'AUTH_PHONE_VERIFICATION_REQUESTED';

      eventBus.publish(eventType, {
        userId: user.id,
        identifier,
        contactType,
        otpCode: otp.code
      });

      return {
        message:
          'Se os dados informados corresponderem a uma conta registada, um novo código foi enviado. O código é válido por 10 minutos.',
        userId: user.id,
        otpCode: otp.code
      };
    }

    return {
      message:
        'Se os dados informados corresponderem a uma conta registada, um novo código foi enviado. O código é válido por 10 minutos.',
      userId: null,
      otpCode: null
    };
  }

  /**
   * Solicitação de recuperação de conta (Esquecimento de senha).
   */
  async forgotPassword(identifier) {
    const user = await authRepository.findByIdentifier(identifier);

    if (user && user.status !== 'BLOCKED' && user.status !== 'DEACTIVATED') {
      const resetTokenData = tokenSecurity.generatePasswordResetToken();

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
      message:
        'Se o contacto informado pertencer a uma conta ativa, as instruções de redefinição foram enviadas.'
    };
  }

  /**
   * Redefinição de palavra-passe através de token de recuperação.
   *
   * ⚠️ SEGURANÇA: o token é procurado APENAS no canal EMAIL_PRIMARY,
   * impedindo que um OTP de verificação de telefone (6 dígitos) seja
   * aceite como token de reset de password.
   */
  async resetPassword({ token, newPassword }) {
    const tokenHash = tokenSecurity.hashToken(token);

    const contactSql = `
      SELECT user_id, verification_code_expires_at
      FROM user_contacts
      WHERE verification_code_hash = $1
        AND contact_type = 'EMAIL_PRIMARY'
        AND verification_code_expires_at > (NOW() AT TIME ZONE 'UTC')
      LIMIT 1;
    `;
    const contactRecord = await queryOne(contactSql, [tokenHash]);

    if (!contactRecord) {
      throw new ValidationError(
        'O link ou token de redefinição de palavra-passe é inválido ou expirou.'
      );
    }

    const userId = contactRecord.user_id;
    const passwordHash = await passwordSecurity.hashPassword(newPassword);

    await withTransaction(async (client) => {
      await authRepository.updatePassword(userId, passwordHash, client);

      await queryClient(
        client,
        `UPDATE user_contacts
         SET verification_code_hash = NULL,
             verification_code_expires_at = NULL,
             updated_at = NOW() AT TIME ZONE 'UTC'
         WHERE user_id = $1 AND contact_type = 'EMAIL_PRIMARY';`,
        [userId]
      );

      await authRepository.revokeAllUserSessions(userId, 'PASSWORD_RESET', client);
    });

    eventBus.publish(EVENT_TYPES.AUTH_PASSWORD_CHANGED, { userId });

    return {
      message:
        'A sua palavra-passe foi redefinida com sucesso. Pode agora iniciar sessão com a nova credencial.'
    };
  }

  /**
   * Alteração de palavra-passe solicitada por utilizador com sessão iniciada.
   */
  async changePassword(userId, { currentPassword, newPassword }) {
    // Uma única query: findById já deve devolver password_hash.
    // Se o repositório não devolver, o bug está lá — não aqui.
    const user = await authRepository.findById(userId);
    if (!user) {
      throw NotFoundError.user(userId);
    }

    if (!user.password_hash) {
      serviceLogger.error(
        `[AUTH:CHANGE_PASSWORD] findById devolveu utilizador sem password_hash (userId=${userId}). Verifique auth.repository.findById.`
      );
      throw new ValidationError(
        'Não foi possível validar a palavra-passe atual. Tente novamente mais tarde.'
      );
    }

    const isCurrentValid = await passwordSecurity.verifyPassword(user.password_hash, currentPassword);
    if (!isCurrentValid) {
      throw new AuthenticationError(
        'A palavra-passe atual inserida está incorreta.',
        'INVALID_CURRENT_PASSWORD'
      );
    }

    const newPasswordHash = await passwordSecurity.hashPassword(newPassword);

    await withTransaction(async (client) => {
      await authRepository.updatePassword(userId, newPasswordHash, client);
      await authRepository.revokeAllUserSessions(userId, 'PASSWORD_CHANGED', client);
    });

    eventBus.publish(EVENT_TYPES.AUTH_PASSWORD_CHANGED, { userId });

    return {
      message:
        'A sua palavra-passe foi alterada com sucesso. Todas as outras sessões foram encerradas.'
    };
  }

  /**
   * Renovação de Access Token e rotação de Refresh Token.
   *
   * ⚠️ SEGURANÇA: a rotação usa lock optimista no UPDATE.
   * Se duas chamadas concorrentes chegarem com o mesmo refresh token,
   * apenas uma vence; a outra recebe erro de sessão revogada.
   */
  async refreshToken(rawRefreshToken, _clientContext = {}) {
    const tokenHash = tokenSecurity.hashToken(rawRefreshToken);
    const session = await authRepository.findSessionByTokenHash(tokenHash);

    if (!session || session.is_revoked || new Date(session.expires_at).getTime() < Date.now()) {
      throw AuthenticationError.sessionRevoked();
    }

    const user = await authRepository.findById(session.user_id);
    if (!user || user.status === 'BLOCKED' || user.status === 'DEACTIVATED') {
      throw new AuthenticationError(
        'Conta de utilizador suspensa ou indisponível.',
        'ACCOUNT_RESTRICTED'
      );
    }

    const newRefreshToken = tokenSecurity.generateRefreshToken();
    const newTokenHash = tokenSecurity.hashToken(newRefreshToken);

    // Lock optimista: só atualiza se o token_hash ainda for o antigo.
    const updateResult = await queryClient(
      null,
      `UPDATE sessions
       SET token_hash = $1,
           last_active_at = NOW() AT TIME ZONE 'UTC',
           updated_at = NOW() AT TIME ZONE 'UTC'
       WHERE id = $2 AND token_hash = $3 AND is_revoked = FALSE;`,
      [newTokenHash, session.id, tokenHash]
    );

    const rowCount = updateResult && typeof updateResult.rowCount === 'number' ? updateResult.rowCount : null;
    if (rowCount !== null && rowCount !== 1) {
      // Outra chamada concorrente já rotacionou o token — tratamos como revogado.
      throw AuthenticationError.sessionRevoked();
    }

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

const authService = new AuthService();

module.exports = authService;