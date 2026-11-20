const { DEFAULT_CURRENCY, isSupportedCurrency, getCurrencyMetadata } = require('../constants/currencies');
const ValidationError = require('../errors/validation-error');

/**
 * Value Object imutável para representação e manipulação de valores monetários na plataforma OneKixikila.
 * Impõe a regra financeira inegociável de cálculo baseado estritamente em inteiros (BigInt / unidades inteiras de Kwanza - AOA),
 * eliminando vulnerabilidades de perda de precisão e anomalias de ponto flutuante do JavaScript (IEEE 754).
 */
class Money {
  /**
   * Construtor privado/protegido. Utilize os métodos estáticos Money.of(), Money.zero() ou Money.parse().
   *
   * @param {bigint|number|string} amount - Quantia monetária representada em unidades inteiras da moeda
   * @param {string} [currency='AOA'] - Código ISO da moeda (padrão 'AOA')
   */
  constructor(amount, currency = DEFAULT_CURRENCY) {
    const normalizedCurrency = typeof currency === 'string' ? currency.trim().toUpperCase() : DEFAULT_CURRENCY;

    if (!isSupportedCurrency(normalizedCurrency)) {
      throw ValidationError.invalidValue('currency', `Moeda [${currency}] não é suportada pelo sistema financeiro.`);
    }

    let parsedAmountBigInt;

    if (typeof amount === 'bigint') {
      parsedAmountBigInt = amount;
    } else if (typeof amount === 'number') {
      if (!Number.isFinite(amount) || Number.isNaN(amount)) {
        throw ValidationError.invalidValue('amount', 'O montante numérico deve ser um número finito e válido.');
      }
      if (!Number.isInteger(amount)) {
        throw ValidationError.invalidValue(
          'amount',
          'O Kwanza opera em unidades inteiras na plataforma. Valores decimais de ponto flutuante são rejeitados.'
        );
      }
      parsedAmountBigInt = BigInt(amount);
    } else if (typeof amount === 'string') {
      const cleanString = amount.trim();
      if (!/^-?\d+$/.test(cleanString)) {
        throw ValidationError.invalidValue('amount', `A cadeia monetária [${amount}] não representa um número inteiro válido.`);
      }
      parsedAmountBigInt = BigInt(cleanString);
    } else {
      throw ValidationError.invalidValue('amount', 'Tipo de dados não suportado para quantia monetária.');
    }

    this.amount = parsedAmountBigInt;
    this.currency = normalizedCurrency;

    Object.freeze(this);
  }

  /**
   * Cria uma instância de Money a partir de um valor numérico ou inteiro.
   *
   * @param {bigint|number|string} amount
   * @param {string} [currency='AOA']
   * @returns {Money}
   */
  static of(amount, currency = DEFAULT_CURRENCY) {
    return new Money(amount, currency);
  }

  /**
   * Cria uma instância com saldo zero na moeda informada.
   *
   * @param {string} [currency='AOA']
   * @returns {Money}
   */
  static zero(currency = DEFAULT_CURRENCY) {
    return new Money(0n, currency);
  }

  /**
   * Realiza o parse rigoroso de entradas de texto ou formulários web.
   * Remove formatações como espaços ou símbolo "Kz".
   *
   * @param {string|number} input
   * @param {string} [currency='AOA']
   * @returns {Money}
   */
  static parse(input, currency = DEFAULT_CURRENCY) {
    if (input === null || input === undefined) {
      throw ValidationError.fieldRequired('amount');
    }

    if (typeof input === 'number') {
      return Money.of(input, currency);
    }

    if (typeof input === 'string') {
      const cleaned = input
        .replace(/Kz/gi, '')
        .replace(/\s+/g, '')
        .replace(/\./g, '')
        .replace(/,/g, '')
        .trim();

      return Money.of(cleaned, currency);
    }

    throw ValidationError.invalidValue('amount', 'Entrada não conversível em representação monetária.');
  }

  /**
   * Valida se outra instância de Money possui a mesma moeda para operações aritméticas.
   * @param {Money} other
   */
  assertSameCurrency(other) {
    if (!(other instanceof Money)) {
      throw new TypeError('O operando deve ser uma instância válida da classe Money.');
    }
    if (this.currency !== other.currency) {
      throw new Error(`Incompatibilidade de moedas na operação financeira: [${this.currency}] vs [${other.currency}].`);
    }
  }

  /**
   * Soma dois valores monetários.
   *
   * @param {Money} other
   * @returns {Money}
   */
  add(other) {
    this.assertSameCurrency(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  /**
   * Subtrai outro valor monetário deste.
   *
   * @param {Money} other
   * @param {boolean} [allowNegative=false] - Se permite resultado negativo
   * @returns {Money}
   */
  subtract(other, allowNegative = false) {
    this.assertSameCurrency(other);
    const result = this.amount - other.amount;

    if (!allowNegative && result < 0n) {
      throw ValidationError.invalidValue(
        'amount',
        `A operação resultaria num saldo negativo (${result} ${this.currency}), violando a integridade de saldos.`
      );
    }

    return new Money(result, this.currency);
  }

  /**
   * Multiplica a quantia por um multiplicador inteiro ou decimal arredondado com precisão.
   *
   * @param {number|bigint} factor
   * @returns {Money}
   */
  multiply(factor) {
    if (typeof factor === 'bigint') {
      return new Money(this.amount * factor, this.currency);
    }

    if (typeof factor !== 'number' || !Number.isFinite(factor)) {
      throw ValidationError.invalidValue('factor', 'O fator de multiplicação deve ser um número finito.');
    }

    // Multiplicação por aproximação inteira ponderada (arredondamento bancário para inteiro mais próximo)
    const factorScaled = BigInt(Math.round(factor * 1000000));
    const result = (this.amount * factorScaled + 500000n) / 1000000n;

    return new Money(result, this.currency);
  }

  /**
   * Aplica uma taxa percentual expressa em pontos-base (basis points: 100 bps = 1.00%).
   *
   * @param {number} basisPoints - Ex: 100 para 1%, 250 para 2.5%
   * @returns {Money}
   */
  applyBasisPoints(basisPoints) {
    if (!Number.isInteger(basisPoints) || basisPoints < 0) {
      throw ValidationError.invalidValue('basisPoints', 'Os pontos-base da taxa devem ser um inteiro positivo.');
    }

    const bpsBigInt = BigInt(basisPoints);
    const feeAmount = (this.amount * bpsBigInt + 5000n) / 10000n;

    return new Money(feeAmount, this.currency);
  }

  /**
   * Distribui o montante entre N partes iguais sem perder resíduos (Martin Fowler Distribution Pattern).
   * O resíduo da divisão inteira é distribuído unidade a unidade nas primeiras partes.
   *
   * @param {number} partsCount - Número de partes
   * @returns {Money[]} Array de instâncias de Money cuja soma é rigorosamente idêntica ao original
   */
  distributeEqually(partsCount) {
    if (!Number.isInteger(partsCount) || partsCount <= 0) {
      throw ValidationError.invalidValue('partsCount', 'A quantidade de partes para partilha deve ser maior que zero.');
    }

    const divisor = BigInt(partsCount);
    const baseShare = this.amount / divisor;
    let remainder = this.amount % divisor;

    const results = [];
    for (let i = 0; i < partsCount; i++) {
      if (remainder > 0n) {
        results.push(new Money(baseShare + 1n, this.currency));
        remainder -= 1n;
      } else {
        results.push(new Money(baseShare, this.currency));
      }
    }

    return results;
  }

  /**
   * Avalia se a quantia é exatamente zero.
   * @returns {boolean}
   */
  isZero() {
    return this.amount === 0n;
  }

  /**
   * Avalia se a quantia é positiva (> 0).
   * @returns {boolean}
   */
  isPositive() {
    return this.amount > 0n;
  }

  /**
   * Avalia se a quantia é negativa (< 0).
   * @returns {boolean}
   */
  isNegative() {
    return this.amount < 0n;
  }

  /**
   * Verifica igualdade com outra instância monetária.
   * @param {Money} other
   * @returns {boolean}
   */
  equals(other) {
    if (!(other instanceof Money)) {
      return false;
    }
    return this.currency === other.currency && this.amount === other.amount;
  }

  /**
   * Compara se este valor é estritamente maior que outro.
   * @param {Money} other
   * @returns {boolean}
   */
  greaterThan(other) {
    this.assertSameCurrency(other);
    return this.amount > other.amount;
  }

  /**
   * Compara se este valor é maior ou igual a outro.
   * @param {Money} other
   * @returns {boolean}
   */
  greaterThanOrEqual(other) {
    this.assertSameCurrency(other);
    return this.amount >= other.amount;
  }

  /**
   * Compara se este valor é estritamente menor que outro.
   * @param {Money} other
   * @returns {boolean}
   */
  lessThan(other) {
    this.assertSameCurrency(other);
    return this.amount < other.amount;
  }

  /**
   * Compara se este valor é menor ou igual a outro.
   * @param {Money} other
   * @returns {boolean}
   */
  lessThanOrEqual(other) {
    this.assertSameCurrency(other);
    return this.amount <= other.amount;
  }

  /**
   * Retorna o valor numérico inteiro (safe integer) para uso em APIs ou SQL.
   * @returns {number}
   */
  toInteger() {
    return Number(this.amount);
  }

  /**
   * Retorna o valor em formato BigInt nativo.
   * @returns {bigint}
   */
  toBigInt() {
    return this.amount;
  }

  /**
   * Formata a quantia monetária segundo os padrões de Angola (ex: "50.000 Kz").
   *
   * @param {string} [locale='pt-AO']
   * @returns {string}
   */
  format(locale = 'pt-AO') {
    const meta = getCurrencyMetadata(this.currency);
    const formattedNumber = Number(this.amount).toLocaleString(locale, {
      maximumFractionDigits: 0
    });
    return `${formattedNumber} ${meta.symbol || 'Kz'}`;
  }

  /**
   * Representação em string para depuração ou logs.
   * @returns {string}
   */
  toString() {
    return `${this.amount.toString()} ${this.currency}`;
  }

  /**
   * Serialização JSON padronizada para APIs e registo de auditoria.
   * @returns {{ amount: number, currency: string, formatted: string }}
   */
  toJSON() {
    return {
      amount: this.toInteger(),
      currency: this.currency,
      formatted: this.format()
    };
  }
}

module.exports = Money;