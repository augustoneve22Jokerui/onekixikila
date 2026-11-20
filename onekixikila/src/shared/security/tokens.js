const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const securityConfig = require('../../config/security');
const limitsConfig = require('../../config/limits');
const AuthenticationError = require('../errors/authentication-error');

/**
 * Módulo de segurança criptográfica para geração, validação, rotação e hashing de tokens
 * na plataforma OneKixikila (Access Tokens JWT, Refresh Tokens, códigos OTP numéricos e tokens de recuperação).
 */
class TokenSecurity {
  /**
   * Gera um Access Token assinado (JWT) com identificadores canónicos e reivindicações de sessão.
   *
   * @param {object} payload - Dados do utilizador autenticado
   * @param {string} payload.userId - Identificador UUID do utilizador
   * @param {string} payload.role - Papel do utilizador (ex: 'USER', 'MEMBER', 'ADMIN')
   * @param {string} [payload.sessionId] - Identificador UUID da sessão ativa
   * @param {string} [customExpiresIn] - Tempo de expiração customizado (opcional)
   * @returns {string} Token JWT assinado
   */
  generateAccessToken(payload, customExpiresIn = null) {
    if (!payload || !payload.userId || !payload.role) {
      throw new Error('Parâmetros obrigatórios ausentes para geração de Access Token (userId, role).');
    }

    const tokenId = crypto.randomUUID();
    const expiresIn = customExpiresIn || securityConfig.jwt.accessTokenExpiresIn || '15m';

    const jwtPayload = {
      sub: payload.userId,
      role: payload.role,
      sessionId: payload.sessionId || null,
      jti: tokenId
    };

    return jwt.sign(jwtPayload, securityConfig.jwt.accessTokenSecret, {
      algorithm: securityConfig.jwt.algorithm || 'HS256',
      issuer: securityConfig.jwt.issuer || 'onekixikila-api',
      audience: securityConfig.jwt.audience || 'onekixikila-clients',
      expiresIn
    });
  }

  /**
   * Valida criptograficamente um Access Token JWT e retorna o payload decodificado.
   *
   * @param {string} token - Token JWT a verificar
   * @returns {object} Payload decodificado do token
   * @throws {AuthenticationError} Caso o token seja inválido, expirado ou corrompido
   */
  verifyAccessToken(token) {
    if (!token || typeof token !== 'string') {
      throw AuthenticationError.invalidToken('Token de acesso não fornecido ou inválido.');
    }

    try {
      return jwt.verify(token, securityConfig.jwt.accessTokenSecret, {
        algorithms: [securityConfig.jwt.algorithm || 'HS256'],
        issuer: securityConfig.jwt.issuer || 'onekixikila-api',
        audience: securityConfig.jwt.audience || 'onekixikila-clients'
      });
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw AuthenticationError.tokenExpired();
      }
      throw AuthenticationError.invalidToken();
    }
  }

  /**
   * Decodifica um token JWT sem validar a assinatura (útil para auditoria ou inspeção prévia de claims).
   *
   * @param {string} token
   * @returns {object|null}
   */
  decodeToken(token) {
    if (!token || typeof token !== 'string') {
      return null;
    }
    return jwt.decode(token, { complete: false });
  }

  /**
   * Gera um Refresh Token opaco de alta entropia (64 caracteres hexadecimais derivados de 32 bytes aleatórios).
   *
   * @returns {string} Token bruto em formato hexadecimal
   */
  generateRefreshToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Gera um token de utilização única para redefinição de palavra-passe ou convite seguro.
   * Retorna o token em texto limpo (para envio ao utilizador) e o seu hash SHA-256 (para persistência na base de dados).
   *
   * @returns {{ token: string, tokenHash: string, expiresAt: Date }}
   */
  generatePasswordResetToken() {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);
    const ttlSeconds = limitsConfig.tokens.passwordResetTtlSeconds || 1800; // 30 minutos
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    return {
      token,
      tokenHash,
      expiresAt
    };
  }

  /**
   * Gera um código de verificação numérico (OTP) criptograficamente seguro para validação via SMS ou Email.
   *
   * @param {number} [digits=6] - Quantidade de dígitos do código (padrão 6 dígitos)
   * @returns {{ code: string, codeHash: string, expiresAt: Date }}
   */
  generateNumericOtp(digits = 6) {
    if (digits < 4 || digits > 8) {
      throw new Error('A quantidade de dígitos do OTP deve estar entre 4 e 8.');
    }

    const min = Math.pow(10, digits - 1);
    const max = Math.pow(10, digits) - 1;
    const randomBuffer = crypto.randomBytes(4);
    const randomInt = randomBuffer.readUInt32BE(0);
    const codeNumber = min + (randomInt % (max - min + 1));
    const code = String(codeNumber);

    const codeHash = this.hashToken(code);
    const ttlSeconds = limitsConfig.tokens.accountVerificationOtpTtlSeconds || 600; // 10 minutos
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    return {
      code,
      codeHash,
      expiresAt
    };
  }

  /**
   * Gera um token alfanumérico seguro para convites dinâmicos de grupos de Kixikila.
   *
   * @param {number} [byteLength=16]
   * @returns {{ inviteCode: string, expiresAt: Date }}
   */
  generateInviteCode(byteLength = 16) {
    const rawCode = crypto.randomBytes(byteLength).toString('base64url');
    const ttlSeconds = limitsConfig.tokens.groupInvitationTtlSeconds || 604800; // 7 dias
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    return {
      inviteCode: rawCode,
      expiresAt
    };
  }

  /**
   * Gera um identificador único de chave de idempotência para cabeçalhos ou requisições críticas.
   *
   * @param {string} [prefix='IDEMP']
   * @returns {string}
   */
  generateIdempotencyKey(prefix = 'IDEMP') {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  /**
   * Calcula o hash SHA-256 de um token bruto para armazenamento seguro em repouso na base de dados.
   *
   * @param {string} token - Token ou código em texto limpo
   * @returns {string} Digest hexadecimal de 64 caracteres
   */
  hashToken(token) {
    if (!token || typeof token !== 'string') {
      throw new Error('Token inválido para cálculo de hash SHA-256.');
    }
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  }

  /**
   * Compara de forma segura (tempo constante / timing-safe) um token em texto limpo com o seu hash armazenado.
   * Previne ataques de temporização (timing attacks).
   *
   * @param {string} rawToken - Token ou código submetido pelo utilizador
   * @param {string} storedHash - Hash SHA-256 recuperado da base de dados
   * @returns {boolean} True se corresponder, False caso contrário
   */
  verifyTokenHash(rawToken, storedHash) {
    if (!rawToken || !storedHash || typeof rawToken !== 'string' || typeof storedHash !== 'string') {
      return false;
    }

    try {
      const calculatedHash = this.hashToken(rawToken);
      const calculatedBuffer = Buffer.from(calculatedHash, 'hex');
      const storedBuffer = Buffer.from(storedHash, 'hex');

      if (calculatedBuffer.length !== storedBuffer.length) {
        return false;
      }

      return crypto.timingSafeEqual(calculatedBuffer, storedBuffer);
    } catch (error) {
      return false;
    }
  }
}

// Instância singleton do serviço de segurança de tokens
const tokenSecurity = new TokenSecurity();

module.exports = tokenSecurity;