const crypto = require('crypto');
const securityConfig = require('../../config/security');
const ApplicationError = require('../errors/application-error');

/**
 * Utilitário de criptografia simétrica autenticada (AEAD) e blind indexing para dados sensíveis em repouso
 * na plataforma OneKixikila (Bilhetes de Identidade, comprovativos bancários, IBANs e dados pessoais restritos).
 *
 * Utiliza o algoritmo padrão da indústria AES-256-GCM com vetor de inicialização (IV) exclusivo
 * por operação e tag de autenticação para prevenir adulteração ou corrupção de dados.
 */
class EncryptionSecurity {
  constructor() {
    this.algorithm = securityConfig.encryption.algorithm || 'aes-256-gcm';
    this.key = securityConfig.encryption.key;
    this.ivLength = securityConfig.encryption.ivLengthBytes || 16;
    this.authTagLength = securityConfig.encryption.authTagLengthBytes || 16;

    if (!this.key || !Buffer.isBuffer(this.key) || this.key.length < 32) {
      throw new Error(
        '[SECURITY:ENCRYPTION] Chave de criptografia inválida. DATA_ENCRYPTION_KEY deve fornecer pelo menos 32 bytes.'
      );
    }
  }

  /**
   * Criptografa uma cadeia de texto utilizando AES-256-GCM.
   * Retorna um pacote formatado com IV, Tag de Autenticação e Texto Cifrado em representação hexadecimal.
   *
   * Formato de saída: iv:authTag:ciphertext
   *
   * @param {string} plainText - Texto limpo a cifrar
   * @param {string} [aad] - Dados Associados Adicionais (AAD) opcionais para vincular integridade contextual
   * @returns {string} String codificada segura para persistência em colunas TEXT/VARCHAR
   */
  encrypt(plainText, aad = null) {
    if (plainText === null || plainText === undefined) {
      return null;
    }

    if (typeof plainText !== 'string') {
      plainText = String(plainText);
    }

    try {
      // 1. Gera um vetor de inicialização (IV) imprevisível e exclusivo para esta cifra
      const iv = crypto.randomBytes(this.ivLength);

      // 2. Instancia a cifra AES-256-GCM
      const cipher = crypto.createCipheriv(this.algorithm, this.key, iv, {
        authTagLength: this.authTagLength
      });

      // 3. Vincula dados associados (AAD) se fornecidos
      if (aad && typeof aad === 'string') {
        cipher.setAAD(Buffer.from(aad, 'utf8'));
      }

      // 4. Executa a cifragem
      const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);

      // 5. Extrai a tag de autenticação GCM
      const authTag = cipher.getAuthTag();

      // Formato compacto delimitado: iv:authTag:ciphertext
      return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
    } catch (error) {
      console.error('[SECURITY:ENCRYPTION:ERROR] Falha durante cifragem de dados:', error.message);
      throw new ApplicationError('Falha no processamento de proteção de dados confidenciais.', 500, 'ENCRYPTION_FAILED');
    }
  }

  /**
   * Decifra um pacote codificado previamente gerado pelo método encrypt().
   * Valida estritamente a tag de autenticação antes de retornar o texto limpo original.
   *
   * @param {string} encryptedPayload - String no formato iv:authTag:ciphertext
   * @param {string} [aad] - Dados Associados Adicionais (deve coincidir com os usados na cifragem)
   * @returns {string|null} Texto original decifrado
   * @throws {ApplicationError} Caso os dados tenham sido adulterados, corrompidos ou chave inválida
   */
  decrypt(encryptedPayload, aad = null) {
    if (!encryptedPayload) {
      return null;
    }

    if (typeof encryptedPayload !== 'string' || !encryptedPayload.includes(':')) {
      throw new ApplicationError('Estrutura de dados cifrados inválida ou mal formada.', 500, 'DECRYPTION_MALFORMED');
    }

    const parts = encryptedPayload.split(':');
    if (parts.length !== 3) {
      throw new ApplicationError('Segmentação de payload criptográfico incorreta.', 500, 'DECRYPTION_MALFORMED');
    }

    const [ivHex, authTagHex, cipherHex] = parts;

    try {
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');
      const cipherText = Buffer.from(cipherHex, 'hex');

      if (iv.length !== this.ivLength || authTag.length !== this.authTagLength) {
        throw new Error('Dimensões do IV ou Tag de autenticação incompatíveis com a especificação GCM.');
      }

      const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv, {
        authTagLength: this.authTagLength
      });

      decipher.setAuthTag(authTag);

      if (aad && typeof aad === 'string') {
        decipher.setAAD(Buffer.from(aad, 'utf8'));
      }

      const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);

      return decrypted.toString('utf8');
    } catch (error) {
      console.error('[SECURITY:DECRYPTION:ERROR] Falha de autenticação ou integridade na decifragem:', error.message);
      throw new ApplicationError(
        'Falha de integridade ao recuperar dados protegidos. Possível adulteração ou chave divergente.',
        500,
        'DECRYPTION_INTEGRITY_FAILED'
      );
    }
  }

  /**
   * Criptografa um objeto estruturado ou payload JSON.
   *
   * @param {object} jsonObject
   * @param {string} [aad]
   * @returns {string|null}
   */
  encryptJson(jsonObject, aad = null) {
    if (jsonObject === null || jsonObject === undefined) {
      return null;
    }
    const serialized = JSON.stringify(jsonObject);
    return this.encrypt(serialized, aad);
  }

  /**
   * Decifra um payload criptográfico e converte de volta para o objeto JSON correspondente.
   *
   * @param {string} encryptedPayload
   * @param {string} [aad]
   * @returns {object|null}
   */
  decryptJson(encryptedPayload, aad = null) {
    const plainText = this.decrypt(encryptedPayload, aad);
    if (!plainText) {
      return null;
    }

    try {
      return JSON.parse(plainText);
    } catch (parseError) {
      console.error('[SECURITY:DECRYPTION:PARSE_ERROR] Conteúdo decifrado não é um JSON válido.');
      throw new ApplicationError('Formato JSON corrompido nos dados decifrados.', 500, 'DECRYPTION_PARSE_FAILED');
    }
  }

  /**
   * Gera um índice cego determinístico (Blind Index via HMAC-SHA256) para campos confidenciais
   * que exigem pesquisa exata na base de dados (ex: busca por número de Bilhete de Identidade ou telefone)
   * sem necessidade de decifrar registos em massa nem expor o dado original em texto limpo.
   *
   * @param {string} value - Valor do campo a indexar (ex: '0054321LA045')
   * @param {string} [contextSalt=''] - Contexto ou sal específico do campo para evitar correlação cruzada
   * @returns {string} Hash determinístico seguro de 64 caracteres hexadecimais
   */
  generateBlindIndex(value, contextSalt = '') {
    if (!value || typeof value !== 'string') {
      return '';
    }

    const normalizedValue = value.trim().toLowerCase();
    const hmacKey = crypto
      .createHmac('sha256', this.key)
      .update(`blind-index-context:${contextSalt}`, 'utf8')
      .digest();

    return crypto
      .createHmac('sha256', hmacKey)
      .update(normalizedValue, 'utf8')
      .digest('hex');
  }

  /**
   * Mascara parcialmente dados confidenciais para exibição segura em interfaces e comprovativos.
   * Exemplo: '0054321LA045' -> '005*****A045' ou 'AO060040...' -> 'AO06 **** **** 1234'
   *
   * @param {string} text - Valor original
   * @param {number} [visibleStart=3] - Caracteres visíveis no início
   * @param {number} [visibleEnd=4] - Caracteres visíveis no fim
   * @returns {string}
   */
  maskSensitive(text, visibleStart = 3, visibleEnd = 4) {
    if (!text || typeof text !== 'string') {
      return '';
    }

    const trimmed = text.trim();
    if (trimmed.length <= visibleStart + visibleEnd) {
      return '*'.repeat(trimmed.length);
    }

    const start = trimmed.slice(0, visibleStart);
    const end = trimmed.slice(-visibleEnd);
    const maskedLength = Math.min(Math.max(trimmed.length - (visibleStart + visibleEnd), 4), 8);

    return `${start}${'*'.repeat(maskedLength)}${end}`;
  }
}

// Instância singleton do utilitário de criptografia
const encryptionSecurity = new EncryptionSecurity();

module.exports = encryptionSecurity;