/**
 * Catálogo canónico de moedas e parâmetros monetários da plataforma OneKixikila.
 * Moeda de curso legal e operacional primária: Kwanza Angolano (AOA).
 */

const DEFAULT_CURRENCY = 'AOA';

const SUPPORTED_CURRENCIES = Object.freeze({
  AOA: Object.freeze({
    code: 'AOA',
    numericCode: '024',
    name: 'Kwanza Angolano',
    plural: 'Kwanzas',
    symbol: 'Kz',
    locale: 'pt-AO',
    minorUnitsRatio: 1, // Na plataforma, o Kwanza é operado estritamente em unidades inteiras (sem cêntimos fracionários)
    minTransactionAmount: 100, // 100 Kz
    maxTransactionAmount: 50000000 // 50.000.000 Kz
  })
});

const ALL_CURRENCY_CODES = Object.freeze(Object.keys(SUPPORTED_CURRENCIES));

/**
 * Valida se determinado código de moeda é suportado pelo motor financeiro.
 * @param {string} code
 * @returns {boolean}
 */
const isSupportedCurrency = (code) => {
  return typeof code === 'string' && ALL_CURRENCY_CODES.includes(code.trim().toUpperCase());
};

/**
 * Obtém os metadados de formatação e regras de uma moeda.
 * @param {string} [code='AOA']
 * @returns {typeof SUPPORTED_CURRENCIES.AOA}
 */
const getCurrencyMetadata = (code = DEFAULT_CURRENCY) => {
  const normalized = typeof code === 'string' ? code.trim().toUpperCase() : DEFAULT_CURRENCY;
  return SUPPORTED_CURRENCIES[normalized] || SUPPORTED_CURRENCIES.AOA;
};

module.exports = {
  DEFAULT_CURRENCY,
  SUPPORTED_CURRENCIES,
  ALL_CURRENCY_CODES,
  isSupportedCurrency,
  getCurrencyMetadata
};