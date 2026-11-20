/**
 * Conjunto exaustivo de nomes de chaves e campos sensíveis que devem ser
 * obrigatoriamente expurgados de qualquer registo de log, depuração ou auditoria técnica.
 */
const SENSITIVE_KEY_PATTERNS = Object.freeze(
  new Set([
    'password',
    'password_hash',
    'passwordhash',
    'newpassword',
    'oldpassword',
    'confirmpassword',
    'token',
    'accesstoken',
    'refreshtoken',
    'jwt',
    'secret',
    'client_secret',
    'clientsecret',
    'apikey',
    'api_key',
    'webhooksecret',
    'webhook_secret',
    'cookie',
    'cookies',
    'authorization',
    'signature',
    'csrftoken',
    'csrf_token',
    '_csrf',
    'cvv',
    'cvc',
    'pin',
    'credit_card',
    'cardnumber',
    'database_url',
    'connectionstring',
    'db_password',
    'privatekey',
    'private_key',
    'data_encryption_key',
    'session_secret'
  ])
);

// Expressão regular para detetar strings de conexão de base de dados (PostgreSQL/Neon)
const DATABASE_URL_REGEX = /postgres(?:ql)?:\/\/[^:]+:[^@]+@[^\s/]+/gi;

// Expressão regular para detetar cabeçalhos Bearer em strings
const BEARER_TOKEN_REGEX = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

/**
 * Avalia se o nome de um campo ou chave de objeto é classificado como sensível.
 *
 * @param {string} keyName
 * @returns {boolean}
 */
const isSensitiveKey = (keyName) => {
  if (!keyName || typeof keyName !== 'string') {
    return false;
  }
  const normalized = keyName.toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_KEY_PATTERNS.has(normalized) || SENSITIVE_KEY_PATTERNS.has(keyName.toLowerCase());
};

/**
 * Mascara um endereço de e-mail preservando apenas os caracteres inicial e final do identificador local.
 * Exemplo: "manuel.kiala@onekixikila.ao" -> "m***a@onekixikila.ao"
 *
 * @param {string} email
 * @returns {string}
 */
const maskEmail = (email) => {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return '[REDACTED_EMAIL]';
  }

  const [localPart, domain] = email.split('@');
  if (localPart.length <= 2) {
    return `*@${domain}`;
  }

  const firstChar = localPart[0];
  const lastChar = localPart[localPart.length - 1];
  return `${firstChar}***${lastChar}@${domain}`;
};

/**
 * Mascara um número de telefone mantendo apenas o prefixo internacional e os últimos dígitos.
 * Exemplo: "+244923000001" -> "+244 923 *** *01"
 *
 * @param {string} phone
 * @returns {string}
 */
const maskPhone = (phone) => {
  if (!phone || typeof phone !== 'string') {
    return '[REDACTED_PHONE]';
  }

  const trimmed = phone.trim();
  if (trimmed.length < 7) {
    return '***-***';
  }

  const start = trimmed.slice(0, 7);
  const end = trimmed.slice(-2);
  return `${start}****${end}`;
};

/**
 * Mascara o número do Bilhete de Identidade (BI) angolano.
 * Exemplo: "005432100LA045" -> "005*****A045"
 *
 * @param {string} idNumber
 * @returns {string}
 */
const maskNationalId = (idNumber) => {
  if (!idNumber || typeof idNumber !== 'string') {
    return '[REDACTED_ID]';
  }

  const trimmed = idNumber.trim();
  if (trimmed.length < 8) {
    return '***';
  }

  return `${trimmed.slice(0, 3)}*****${trimmed.slice(-4)}`;
};

/**
 * Mascara um IBAN bancário angolano.
 * Exemplo: "AO06004000001234567890123" -> "AO06 **** **** **** 0123"
 *
 * @param {string} iban
 * @returns {string}
 */
const maskIban = (iban) => {
  if (!iban || typeof iban !== 'string') {
    return '[REDACTED_IBAN]';
  }

  const trimmed = iban.trim();
  if (trimmed.length < 10) {
    return 'AO06 ****';
  }

  return `${trimmed.slice(0, 4)} **** **** **** ${trimmed.slice(-4)}`;
};

/**
 * Sanitiza valores literais de strings que possam conter tokens Bearer ou strings de conexão com senhas.
 *
 * @param {string} str
 * @returns {string}
 */
const sanitizeStringValue = (str) => {
  return str
    .replace(DATABASE_URL_REGEX, 'postgresql://[REDACTED_USER]:[REDACTED_PASS]@[REDACTED_HOST]/[REDACTED_DB]')
    .replace(BEARER_TOKEN_REGEX, 'Bearer [REDACTED_TOKEN]');
};

/**
 * Higieniza recursivamente qualquer estrutura de dados (objetos, matrizes ou primitivos)
 * para exibição segura em logs, rastreadores e observabilidade técnica.
 * Utiliza um conjunto fraco (WeakSet) para prevenir recursão infinita provocada por referências circulares.
 *
 * @param {any} data - Carga de dados bruta
 * @param {WeakSet<object>} [seen=new WeakSet()] - Guarda interna de ciclos circulares
 * @returns {any} Estrutura de dados limpa com campos sensíveis substituídos por '[REDACTED]'
 */
const redactSensitive = (data, seen = new WeakSet()) => {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    return sanitizeStringValue(data);
  }

  if (typeof data !== 'object') {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return `[BUFFER: ${data.length} bytes]`;
  }

  if (data instanceof Error) {
    return {
      name: data.name,
      message: sanitizeStringValue(data.message),
      code: data.code || undefined,
      ...(data.stack ? { stack: sanitizeStringValue(data.stack) } : {})
    };
  }

  // Previne loop infinito em estruturas de dados circulares
  if (seen.has(data)) {
    return '[CIRCULAR_REFERENCE]';
  }
  seen.add(data);

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitive(item, seen));
  }

  const cleanedObject = {};

  for (const [key, value] of Object.entries(data)) {
    if (isSensitiveKey(key)) {
      cleanedObject[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      cleanedObject[key] = redactSensitive(value, seen);
    } else if (typeof value === 'string') {
      cleanedObject[key] = sanitizeStringValue(value);
    } else {
      cleanedObject[key] = value;
    }
  }

  return cleanedObject;
};

module.exports = {
  isSensitiveKey,
  maskEmail,
  maskPhone,
  maskNationalId,
  maskIban,
  redactSensitive
};