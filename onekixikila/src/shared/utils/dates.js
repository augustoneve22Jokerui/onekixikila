/**
 * Utilitários para manipulação, formatação e cálculo de datas e calendários de Kixikila
 * na plataforma OneKixikila.
 *
 * Assegura persistência e comparações universais em UTC na base de dados Neon PostgreSQL,
 * com suporte nativo à formatação regional de Angola (fuso horário WAT - West Africa Time e locale pt-AO).
 */

const LOCALE_ANGOLA = 'pt-AO';
const TIMEZONE_ANGOLA = 'Africa/Luanda'; // WAT (UTC+1)

/**
 * Converte com segurança entradas heterogéneas (Date, string ISO, timestamp) para uma instância válida de Date.
 *
 * @param {Date|string|number} input
 * @returns {Date}
 */
const toDate = (input) => {
  if (input instanceof Date) {
    if (isNaN(input.getTime())) {
      throw new TypeError('Instância de Date inválida fornecida.');
    }
    return input;
  }

  if (typeof input === 'string' || typeof input === 'number') {
    const parsed = new Date(input);
    if (isNaN(parsed.getTime())) {
      throw new TypeError(`Impossível converter valor [${input}] para data válida.`);
    }
    return parsed;
  }

  throw new TypeError('Tipo de entrada inválido para conversão de data.');
};

/**
 * Retorna o momento atual no formato ISO 8601 em UTC.
 * @returns {string}
 */
const nowUtc = () => new Date().toISOString();

/**
 * Adiciona dias a uma data de referência.
 *
 * @param {Date|string|number} date
 * @param {number} days
 * @returns {Date}
 */
const addDays = (date, days) => {
  const d = new Date(toDate(date).getTime());
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d;
};

/**
 * Adiciona meses a uma data de referência.
 *
 * @param {Date|string|number} date
 * @param {number} months
 * @returns {Date}
 */
const addMonths = (date, months) => {
  const d = new Date(toDate(date).getTime());
  d.setUTCMonth(d.getUTCMonth() + Number(months));
  return d;
};

/**
 * Adiciona semanas a uma data de referência.
 *
 * @param {Date|string|number} date
 * @param {number} weeks
 * @returns {Date}
 */
const addWeeks = (date, weeks) => {
  return addDays(date, weeks * 7);
};

/**
 * Calcula a data de vencimento seguinte com base na periodicidade da Kixikila.
 *
 * @param {Date|string|number} fromDate - Data de início ou última rodada
 * @param {'DAILY'|'WEEKLY'|'BIWEEKLY'|'MONTHLY'} frequency - Frequência do grupo
 * @returns {Date} Próxima data de vencimento
 */
const calculateNextDueDate = (fromDate, frequency) => {
  const base = toDate(fromDate);

  switch (frequency) {
    case 'DAILY':
      return addDays(base, 1);
    case 'WEEKLY':
      return addWeeks(base, 1);
    case 'BIWEEKLY':
      return addWeeks(base, 2);
    case 'MONTHLY':
      return addMonths(base, 1);
    default:
      throw new Error(`Frequência de grupo [${frequency}] não reconhecida.`);
  }
};

/**
 * Calcula a data limite de tolerância (Grace Period End Date) para uma quota de Kixikila.
 *
 * @param {Date|string} dueDate - Data de vencimento formal
 * @param {number} [graceDays=2] - Dias de carência permitidos pelas regras do grupo
 * @returns {Date} Data final de tolerância
 */
const calculateGraceEndDate = (dueDate, graceDays = 2) => {
  return addDays(dueDate, graceDays);
};

/**
 * Retorna o início absoluto do dia (00:00:00.000 UTC).
 *
 * @param {Date|string|number} date
 * @returns {Date}
 */
const startOfDayUtc = (date) => {
  const d = new Date(toDate(date).getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/**
 * Retorna o fim absoluto do dia (23:59:59.999 UTC).
 *
 * @param {Date|string|number} date
 * @returns {Date}
 */
const endOfDayUtc = (date) => {
  const d = new Date(toDate(date).getTime());
  d.setUTCHours(23, 59, 59, 999);
  return d;
};

/**
 * Avalia se determinada data já expirou em relação ao momento presente.
 *
 * @param {Date|string|number} date
 * @returns {boolean}
 */
const isPast = (date) => {
  return toDate(date).getTime() < Date.now();
};

/**
 * Avalia se determinada data está no futuro.
 *
 * @param {Date|string|number} date
 * @returns {boolean}
 */
const isFuture = (date) => {
  return toDate(date).getTime() > Date.now();
};

/**
 * Calcula a diferença em dias corridos inteiros entre duas datas.
 *
 * @param {Date|string} targetDate
 * @param {Date|string} [baseDate=new Date()]
 * @returns {number}
 */
const differenceInDays = (targetDate, baseDate = new Date()) => {
  const t = toDate(targetDate).getTime();
  const b = toDate(baseDate).getTime();
  const diffMs = t - b;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
};

/**
 * Formata uma data para exibição no padrão por extenso de Angola (ex: "24 de Outubro de 2026").
 *
 * @param {Date|string|number} date
 * @returns {string}
 */
const formatLongDate = (date) => {
  const d = toDate(date);
  return new Intl.DateTimeFormat(LOCALE_ANGOLA, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: TIMEZONE_ANGOLA
  }).format(d);
};

/**
 * Formata data e hora para extratos bancários e recibos (ex: "24/10/2026 21:06:47").
 *
 * @param {Date|string|number} date
 * @returns {string}
 */
const formatReceiptTimestamp = (date) => {
  const d = toDate(date);
  return new Intl.DateTimeFormat(LOCALE_ANGOLA, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: TIMEZONE_ANGOLA
  }).format(d);
};

/**
 * Formata uma data estritamente para o padrão SQL DATE ('YYYY-MM-DD').
 *
 * @param {Date|string|number} date
 * @returns {string}
 */
const toSqlDateString = (date) => {
  const d = toDate(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

module.exports = {
  LOCALE_ANGOLA,
  TIMEZONE_ANGOLA,
  toDate,
  nowUtc,
  addDays,
  addWeeks,
  addMonths,
  calculateNextDueDate,
  calculateGraceEndDate,
  startOfDayUtc,
  endOfDayUtc,
  isPast,
  isFuture,
  differenceInDays,
  formatLongDate,
  formatReceiptTimestamp,
  toSqlDateString
};