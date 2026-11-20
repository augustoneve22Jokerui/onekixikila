/**
 * Módulo de higienização de entradas, prevenção contra XSS (Cross-Site Scripting),
 * proteção contra Path Traversal, prototype pollution e normalização de dados específicos de Angola
 * (números móveis, Bilhetes de Identidade e IBANs bancários) na plataforma OneKixikila.
 */

// Mapa de caracteres especiais para escape de entidades HTML
const HTML_ESCAPE_MAP = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
  '`': '&#x60;'
});

const HTML_ESCAPE_REGEX = /[&<>"'`/]/g;

// Expressão para remoção de caracteres de controlo invisíveis perigosos (ASCII 0 a 31 exceto newline e tab)
const DANGEROUS_CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// Propriedades proibidas em objetos para neutralização de Prototype Pollution
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Escapa caracteres especiais em strings para renderização segura em contexto HTML, prevenindo XSS.
 *
 * @param {string} text - Texto a ser escapado
 * @returns {string} Texto com entidades HTML codificadas
 */
const escapeHtml = (text) => {
  if (text === null || text === undefined) {
    return '';
  }
  if (typeof text !== 'string') {
    text = String(text);
  }
  return text.replace(HTML_ESCAPE_REGEX, (match) => HTML_ESCAPE_MAP[match]);
};

/**
 * Remove caracteres de controlo ASCII perigosos e invisíveis de uma cadeia de texto.
 *
 * @param {string} text
 * @returns {string}
 */
const stripControlChars = (text) => {
  if (typeof text !== 'string') {
    return '';
  }
  return text.replace(DANGEROUS_CONTROL_CHARS_REGEX, '');
};

/**
 * Higieniza nomes de ficheiro submetidos pelo utilizador, prevenindo ataques de Path Traversal
 * (remoção de sequências ../, barras, caracteres nulos e caracteres de controlo).
 *
 * @param {string} fileName - Nome original do ficheiro
 * @returns {string} Nome de ficheiro seguro
 */
const sanitizeFileName = (fileName) => {
  if (!fileName || typeof fileName !== 'string') {
    return 'unnamed_file';
  }

  // Remove caracteres nulos, barras de diretório e sequências de traversal
  let cleanName = fileName
    .replace(/\0/g, '')
    .replace(/[/\\]+/g, '_')
    .replace(/\.\.+/g, '.')
    .replace(DANGEROUS_CONTROL_CHARS_REGEX, '')
    .trim();

  // Limita o tamanho e assegura nome padrão caso fique vazio
  if (cleanName.length === 0 || cleanName === '.') {
    cleanName = 'unnamed_file';
  }

  return cleanName.slice(0, 200);
};

/**
 * Normaliza e higieniza números de telefone angolanos (+244 9xx xxx xxx).
 * Remove pontuações, espaços e adiciona o indicativo internacional padrão +244 caso ausente.
 *
 * @param {string} phone - Número de telefone bruto
 * @returns {string|null} Número formatado no padrão internacional canónico (+2449XXXXXXXX) ou null se inválido
 */
const sanitizePhoneNumber = (phone) => {
  if (!phone || typeof phone !== 'string') {
    return null;
  }

  // Remove todos os caracteres que não sejam dígitos
  let digitsOnly = phone.replace(/\D/g, '');

  // Trata prefixo internacional de Angola
  if (digitsOnly.startsWith('244') && digitsOnly.length === 12) {
    digitsOnly = digitsOnly.substring(3);
  }

  // Número móvel angolano possui exatamente 9 dígitos iniciados por 9
  if (/^9[1-9]\d{7}$/.test(digitsOnly)) {
    return `+244${digitsOnly}`;
  }

  return null;
};

/**
 * Normaliza e higieniza o formato do Bilhete de Identidade (BI) nacional angolano.
 * Formato padrão: 9 dígitos + 2 letras da província + 3 dígitos (ex: 005432100LA045).
 *
 * @param {string} idNumber - Número de BI bruto
 * @returns {string} BI em maiúsculas sem espaços ou hífens
 */
const sanitizeNationalId = (idNumber) => {
  if (!idNumber || typeof idNumber !== 'string') {
    return '';
  }
  return idNumber.trim().replace(/[\s.-]/g, '').toUpperCase();
};

/**
 * Normaliza e higieniza IBAN bancário angolano.
 * Formato padrão: AO06 seguido de 21 dígitos numéricos (total 25 caracteres).
 *
 * @param {string} iban - IBAN bancário bruto
 * @returns {string} IBAN em maiúsculas sem espaços
 */
const sanitizeIban = (iban) => {
  if (!iban || typeof iban !== 'string') {
    return '';
  }
  return iban.trim().replace(/\s+/g, '').toUpperCase();
};

/**
 * Gera um slug alfanumérico seguro para URLs a partir do nome de um grupo de Kixikila.
 * Converte acentos, remove pontuações e substitui espaços por hífens.
 *
 * @param {string} text - Nome ou título do grupo
 * @returns {string} Slug limpo (ex: "kixikila-solidaria-talatona")
 */
const generateSlug = (text) => {
  if (!text || typeof text !== 'string') {
    return '';
  }

  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacríticos e acentos
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove caracteres que não sejam letras, números ou espaços
    .trim()
    .replace(/[\s_]+/g, '-') // Substitui espaços por hífen
    .replace(/-+/g, '-') // Remove hífens duplicados
    .slice(0, 100);
};

/**
 * Escapa caracteres curinga de consultas SQL LIKE (% e _) para busca textual literal segura.
 *
 * @param {string} text - Texto de pesquisa
 * @returns {string} Texto com curingas escapados por barra invertida
 */
const escapeSqlLike = (text) => {
  if (typeof text !== 'string') {
    return '';
  }
  return text.replace(/[%_\\]/g, '\\$&');
};

/**
 * Higieniza recursivamente objetos e matrizes:
 * - Neutraliza chaves perigosas de prototype pollution (__proto__, constructor, prototype)
 * - Remove caracteres de controlo invisíveis em strings
 * - Aplica trim() em todas as cadeias de texto
 *
 * @param {any} data - Carga de dados bruta
 * @returns {any} Objeto profundamente higienizado
 */
const sanitizePayload = (data) => {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    return stripControlChars(data).trim();
  }

  if (Array.isArray(data)) {
    return data.map(sanitizePayload);
  }

  if (typeof data === 'object') {
    const cleanObject = {};
    for (const [key, value] of Object.entries(data)) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        continue; // Descarta tentativas de prototype pollution
      }
      cleanObject[key] = sanitizePayload(value);
    }
    return cleanObject;
  }

  return data;
};

module.exports = {
  escapeHtml,
  stripControlChars,
  sanitizeFileName,
  sanitizePhoneNumber,
  sanitizeNationalId,
  sanitizeIban,
  generateSlug,
  escapeSqlLike,
  sanitizePayload
};