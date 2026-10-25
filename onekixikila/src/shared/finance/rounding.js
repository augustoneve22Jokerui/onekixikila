const ValidationError = require('../errors/validation-error');

/**
 * Modos canónicos de arredondamento financeiro suportados pela plataforma OneKixikila.
 */
const ROUNDING_MODES = Object.freeze({
  HALF_EVEN: 'HALF_EVEN', // Arredondamento Bancário (Round half to even - Padrão IEEE 754 / Contabilidade)
  HALF_UP: 'HALF_UP',     // Arredondamento comercial aritmético comum (>= .5 sobe)
  FLOOR: 'FLOOR',         // Truncamento em direção a menos infinito
  CEIL: 'CEIL',           // Arredondamento sempre para cima
  TRUNCATE: 'TRUNCATE'    // Descarte estrito da parte fracionária
});

/**
 * Utilitário especializado em regras de arredondamento determinístico e partilha de resíduos
 * para cálculos de comissões, taxas percentuais em pontos-base e quotas na moeda nacional (AOA).
 * Garante que nenhuma operação gere frações não representáveis ou desvios de balanço contábil.
 */
class RoundingService {
  /**
   * Executa arredondamento bancário (Half-Even) de um valor decimal para o número inteiro mais próximo.
   * Quando o valor está exatamente a meio caminho (ex: 12.5 ou 13.5), arredonda para o número par mais próximo.
   *
   * @param {number} value - Valor numérico de entrada
   * @returns {bigint} Valor inteiro resultante
   */
  roundHalfEven(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw ValidationError.invalidValue('value', 'O valor para arredondamento deve ser um número finito.');
    }

    const floor = Math.floor(value);
    const diff = value - floor;

    // Se não há fração ou a diferença não está na metade exata
    if (diff < 0.5) {
      return BigInt(floor);
    }
    if (diff > 0.5) {
      return BigInt(floor + 1);
    }

    // Caso exato de empate (.5): arredonda para o inteiro par
    return floor % 2 === 0 ? BigInt(floor) : BigInt(floor + 1);
  }

  /**
   * Executa arredondamento comercial tradicional (Half-Up).
   * Valores com fração igual ou superior a 0.5 são promovidos para o teto.
   *
   * @param {number} value
   * @returns {bigint}
   */
  roundHalfUp(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw ValidationError.invalidValue('value', 'O valor para arredondamento deve ser um número finito.');
    }
    return BigInt(Math.round(value));
  }

  /**
   * Arredonda sempre para o inteiro superior (Ceil).
   *
   * @param {number} value
   * @returns {bigint}
   */
  roundCeil(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw ValidationError.invalidValue('value', 'O valor para arredondamento deve ser um número finito.');
    }
    return BigInt(Math.ceil(value));
  }

  /**
   * Trunca para o inteiro inferior (Floor).
   *
   * @param {number} value
   * @returns {bigint}
   */
  roundFloor(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw ValidationError.invalidValue('value', 'O valor para arredondamento deve ser um número finito.');
    }
    return BigInt(Math.floor(value));
  }

  /**
   * Aplica um modo de arredondamento genérico.
   *
   * @param {number} value
   * @param {string} [mode='HALF_EVEN']
   * @returns {bigint}
   */
  round(value, mode = ROUNDING_MODES.HALF_EVEN) {
    switch (mode) {
      case ROUNDING_MODES.HALF_EVEN:
        return this.roundHalfEven(value);
      case ROUNDING_MODES.HALF_UP:
        return this.roundHalfUp(value);
      case ROUNDING_MODES.CEIL:
        return this.roundCeil(value);
      case ROUNDING_MODES.FLOOR:
      case ROUNDING_MODES.TRUNCATE:
        return this.roundFloor(value);
      default:
        throw ValidationError.invalidValue('mode', `Modo de arredondamento [${mode}] não reconhecido.`);
    }
  }

  /**
   * Calcula taxas proporcionais com base em pontos-base (100 basis points = 1.00%)
   * aplicando arredondamento determinístico em inteiros de Kwanzas.
   *
   * @param {bigint|number} principalAmount - Montante base em Kwanzas inteiros
   * @param {number} basisPoints - Pontos-base (ex: 150 = 1.50%)
   * @param {string} [mode='HALF_EVEN'] - Modo de arredondamento
   * @returns {bigint} Montante da taxa calculado
   */
  calculateBasisPointsFee(principalAmount, basisPoints, mode = ROUNDING_MODES.HALF_EVEN) {
    const principalBigInt = typeof principalAmount === 'bigint' ? principalAmount : BigInt(principalAmount);

    if (!Number.isInteger(basisPoints) || basisPoints < 0) {
      throw ValidationError.invalidValue('basisPoints', 'Os pontos-base devem ser um número inteiro maior ou igual a zero.');
    }

    if (basisPoints === 0 || principalBigInt === 0n) {
      return 0n;
    }

    // Cálculo em ponto fixo escalado: (principal * basisPoints) / 10.000
    const numerator = principalBigInt * BigInt(basisPoints);
    const quotient = numerator / 10000n;
    const remainder = numerator % 10000n;

    // Se não há resíduo fracionário, o resultado é exato
    if (remainder === 0n) {
      return quotient;
    }

    // Avalia o resíduo para arredondamento de acordo com a política
    const fraction = Number(remainder) / 10000;
    const adjustment = this.round(Number(quotient) + fraction, mode) - quotient;

    return quotient + adjustment;
  }

  /**
   * Divide uma quantia inteira em proporções ponderadas (ratios) assegurando que a soma dos pedaços
   * seja matematicamente idêntica ao montante original sem perda de resíduos (conservação de fundos).
   *
   * @param {bigint|number} totalAmount - Montante total a partilhar
   * @param {number[]} ratios - Pesos relativos de partilha (ex: [1, 1, 2])
   * @returns {bigint[]} Distribuição de quotas cuja soma total coincide com totalAmount
   */
  distributeByRatios(totalAmount, ratios) {
    const totalBigInt = typeof totalAmount === 'bigint' ? totalAmount : BigInt(totalAmount);

    if (!Array.isArray(ratios) || ratios.length === 0) {
      throw ValidationError.invalidValue('ratios', 'A lista de proporções não pode estar vazia.');
    }

    let totalWeight = 0;
    for (const r of ratios) {
      if (!Number.isInteger(r) || r <= 0) {
        throw ValidationError.invalidValue('ratios', 'Todas as proporções de partilha devem ser números inteiros estritamente positivos.');
      }
      totalWeight += r;
    }

    const weightBigInt = BigInt(totalWeight);
    const distributed = [];
    let allocatedSum = 0n;

    // 1. Atribui a porção inteira base para cada peso
    for (const r of ratios) {
      const share = (totalBigInt * BigInt(r)) / weightBigInt;
      distributed.push(share);
      allocatedSum += share;
    }

    // 2. Calcula o resíduo que sobrou devido a arredondamento inteiro
    let remainder = totalBigInt - allocatedSum;

    // 3. Distribui o resíduo de 1 em 1 Kwanza começando pelas partes com maior fração não alocada
    let index = 0;
    while (remainder > 0n) {
      distributed[index] += 1n;
      remainder -= 1n;
      index = (index + 1) % distributed.length;
    }

    return distributed;
  }
}

// Instância singleton do serviço de arredondamento
const roundingService = new RoundingService();

module.exports = {
  ROUNDING_MODES,
  roundingService,
  RoundingService
};