const crypto = require('crypto');

// Dicionário de caracteres alfanuméricos sem ambiguidades visuais para geração de códigos
const ALPHANUMERIC_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const DIGITS_CHARS = '0123456789';

/**
 * Utilitários criptográficos de uso geral para a plataforma OneKixikila.
 * Fornece métodos padronizados para geração de sequências aleatórias de alta entropia,
 * cálculo de digests SHA-256/SHA-512, HMACs e comparação em tempo constante.
 */
class CryptoUtils {
  /**
   * Gera uma string hexadecimal aleatória com o comprimento especificado em bytes.
   *
   * @param {number} [bytes=32]
   * @returns {string} String hexadecimal (comprimento = bytes * 2)
   */
  randomHex(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
  }

  /**
   * Gera uma string codificada em Base64URL segura para URLs e tokens.
   *
   * @param {number} [bytes=32]
   * @returns {string}
   */
  randomBase64Url(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
  }

  /**
   * Gera um UUID v4 criptograficamente seguro.
   *
   * @returns {string} UUID canónico (ex: "f47ac10b-58cc-4372-a567-0e02b2c3d479")
   */
  generateUuid() {
    return crypto.randomUUID();
  }

  /**
   * Gera um número inteiro criptograficamente seguro dentro de um intervalo inclusivo [min, max].
   *
   * @param {number} min - Limite inferior
   * @param {number} max - Limite superior
   * @returns {number}
   */
  randomInt(min, max) {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
      throw new TypeError('Intervalo inválido para randomInt. min e max devem ser inteiros e min <= max.');
    }
    return crypto.randomInt(min, max + 1);
  }

  /**
   * Gera uma sequência alfanumérica segura com o comprimento desejado.
   *
   * @param {number} [length=16]
   * @returns {string}
   */
  randomAlphanumeric(length = 16) {
    if (length <= 0) {
      return '';
    }

    const charsLength = ALPHANUMERIC_CHARS.length;
    const randomBytesBuffer = crypto.randomBytes(length);
    let result = '';

    for (let i = 0; i < length; i++) {
      result += ALPHANUMERIC_CHARS[randomBytesBuffer[i] % charsLength];
    }

    return result;
  }

  /**
   * Gera um código exclusivamente numérico (OTP) com o número de dígitos pretendido.
   *
   * @param {number} [length=6]
   * @returns {string}
   */
  randomDigits(length = 6) {
    if (length <= 0) {
      return '';
    }

    const charsLength = DIGITS_CHARS.length;
    const randomBytesBuffer = crypto.randomBytes(length);
    let result = '';

    for (let i = 0; i < length; i++) {
      result += DIGITS_CHARS[randomBytesBuffer[i] % charsLength];
    }

    return result;
  }

  /**
   * Calcula o hash SHA-256 de uma string ou buffer.
   *
   * @param {string|Buffer} data
   * @returns {string} Digest hexadecimal de 64 caracteres
   */
  sha256(data) {
    const input = Buffer.isBuffer(data) ? data : String(data || '');
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  /**
   * Calcula o hash SHA-512 de uma string ou buffer.
   *
   * @param {string|Buffer} data
   * @returns {string} Digest hexadecimal de 128 caracteres
   */
  sha512(data) {
    const input = Buffer.isBuffer(data) ? data : String(data || '');
    return crypto.createHash('sha512').update(input).digest('hex');
  }

  /**
   * Calcula o código de autenticação de mensagem baseado em hash (HMAC-SHA256).
   *
   * @param {string} secret - Chave secreta
   * @param {string|Buffer} data - Dados a autenticar
   * @returns {string} Digest hexadecimal HMAC
   */
  hmacSha256(secret, data) {
    if (!secret || typeof secret !== 'string') {
      throw new Error('Chave secreta obrigatória para cálculo de HMAC-SHA256.');
    }
    const input = Buffer.isBuffer(data) ? data : String(data || '');
    return crypto.createHmac('sha256', secret).update(input).digest('hex');
  }

  /**
   * Compara duas strings ou buffers em tempo constante (Timing-Safe)
   * para mitigar ataques de temporização (Timing Attacks).
   *
   * @param {string|Buffer} a
   * @param {string|Buffer} b
   * @returns {boolean} True se idênticos, False caso contrário
   */
  timingSafeEqual(a, b) {
    if (!a || !b) {
      return false;
    }

    try {
      const bufA = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8');
      const bufB = Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8');

      if (bufA.length !== bufB.length) {
        return false;
      }

      return crypto.timingSafeEqual(bufA, bufB);
    } catch (e) {
      return false;
    }
  }

  /**
   * Calcula o checksum SHA-256 de um ficheiro carregado ou buffer em memória.
   *
   * @param {Buffer} buffer
   * @returns {string}
   */
  calculateFileHash(buffer) {
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('Buffer válido obrigatório para cálculo de hash de ficheiro.');
    }
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}

// Instância singleton de utilitários criptográficos
const cryptoUtils = new CryptoUtils();

module.exports = cryptoUtils;