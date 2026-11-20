const argon2 = require('argon2');
const securityConfig = require('../../config/security');

// Expressões regulares para verificação de força de palavras-passe
const HAS_UPPERCASE = /[A-Z]/;
const HAS_LOWERCASE = /[a-z]/;
const HAS_NUMBER = /\d/;
const HAS_SPECIAL = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/;

/**
 * Utilitário de segurança criptográfica para gestão de palavras-passe na plataforma OneKixikila.
 * Utiliza o algoritmo padrão da indústria Argon2id com custos parametrizados.
 */
class PasswordSecurity {
  /**
   * Gera o hash criptográfico seguro da palavra-passe utilizando Argon2id.
   *
   * @param {string} plainPassword - Palavra-passe em texto limpo
   * @returns {Promise<string>} Hash codificado no padrão PHC
   */
  async hashPassword(plainPassword) {
    if (!plainPassword || typeof plainPassword !== 'string') {
      throw new Error('A palavra-passe deve ser uma cadeia de caracteres válida.');
    }

    if (plainPassword.length < 8) {
      throw new Error('A palavra-passe deve conter no mínimo 8 caracteres.');
    }

    return argon2.hash(plainPassword, securityConfig.argon2);
  }

  /**
   * Verifica em tempo seguro se a palavra-passe informada coincide com o hash gravado.
   *
   * @param {string} hash - Hash Argon2id recuperado da base de dados
   * @param {string} plainPassword - Palavra-passe submetida no login
   * @returns {Promise<boolean>}
   */
  async verifyPassword(hash, plainPassword) {
    if (!hash || !plainPassword || typeof hash !== 'string' || typeof plainPassword !== 'string') {
      return false;
    }

    try {
      return await argon2.verify(hash, plainPassword);
    } catch (error) {
      console.error('[SECURITY:PASSWORD] Falha ao verificar hash da palavra-passe:', error.message);
      return false;
    }
  }

  /**
   * Avalia se determinado hash precisa de recálculo com parâmetros de custo atualizados.
   *
   * @param {string} hash
   * @returns {boolean}
   */
  needsRehash(hash) {
    if (!hash || typeof hash !== 'string') {
      return false;
    }
    return argon2.needsRehash(hash, securityConfig.argon2);
  }

  /**
   * Valida a entropia e as políticas de complexidade da palavra-passe.
   *
   * @param {string} password
   * @returns {{ isValid: boolean, issues: string[] }}
   */
  validatePasswordStrength(password) {
    const issues = [];

    if (!password || typeof password !== 'string') {
      return { isValid: false, issues: ['A palavra-passe é obrigatória.'] };
    }

    if (password.length < 8) {
      issues.push('Deve conter pelo menos 8 caracteres.');
    }

    if (password.length > 128) {
      issues.push('Não pode exceder 128 caracteres.');
    }

    if (!HAS_UPPERCASE.test(password)) {
      issues.push('Deve conter pelo menos uma letra maiúscula.');
    }

    if (!HAS_LOWERCASE.test(password)) {
      issues.push('Deve conter pelo menos uma letra minúscula.');
    }

    if (!HAS_NUMBER.test(password)) {
      issues.push('Deve conter pelo menos um número.');
    }

    if (!HAS_SPECIAL.test(password)) {
      issues.push('Deve conter pelo menos um caractere especial (!@#$%^&*...).');
    }

    return {
      isValid: issues.length === 0,
      issues
    };
  }
}

// Instância singleton do utilitário
const passwordSecurity = new PasswordSecurity();

module.exports = passwordSecurity;