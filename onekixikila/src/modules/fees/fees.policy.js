const { USER_ROLES } = require('../../shared/constants/roles');

// Operações financeiras canónicas sujeitas a tarifação (alinhadas à migração 010)
const ALLOWED_FEE_OPERATIONS = new Set([
  'DEPOSIT',
  'WITHDRAWAL',
  'INTERNAL_TRANSFER',
  'CONTRIBUTION_PAYMENT',
  'ROTATION_PAYOUT',
  'PLATFORM_FEE',
  'LATE_PENALTY'
]);

// Tipos de cálculo de taxas suportados
const ALLOWED_CALCULATION_TYPES = new Set(['FLAT', 'PERCENTAGE', 'HYBRID']);

// Papéis administrativos com permissão formal para gerir a matriz de tarifas da plataforma
const FEE_MANAGEMENT_ROLES = new Set([USER_ROLES.ADMIN, USER_ROLES.FINANCIAL_OPERATOR]);

/**
 * Políticas de autorização, integridade de tarifação e limites regulatórios
 * para a gestão e cálculo de Taxas e Comissões da plataforma OneKixikila.
 */
class FeesPolicy {
  /**
   * Avalia se o utilizador atuante detém privilégios para criar, editar ou desativar tarifas da plataforma.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canManageFees(actingUser) {
    if (!actingUser) {
      return { allowed: false, reason: 'Autenticação necessária.' };
    }

    if (!FEE_MANAGEMENT_ROLES.has(actingUser.role)) {
      return {
        allowed: false,
        reason: 'A gestão da matriz de tarifas da plataforma exige privilégios de ADMIN ou FINANCIAL_OPERATOR.'
      };
    }

    return { allowed: true };
  }

  /**
   * Valida a integridade dos parâmetros da tarifa contra distorções matemáticas e regulatórias.
   *
   * @param {object} feeData
   * @returns {{ valid: boolean, reason?: string }}
   */
  validateFeeStructure(feeData) {
    if (!feeData) {
      return { valid: false, reason: 'Estrutura de parâmetros da tarifa vazia.' };
    }

    if (!ALLOWED_FEE_OPERATIONS.has(feeData.operationType)) {
      return {
        valid: false,
        reason: `Tipo de operação financeira [${feeData.operationType}] não suportado para tarifação.`
      };
    }

    if (!ALLOWED_CALCULATION_TYPES.has(feeData.calculationType)) {
      return {
        valid: false,
        reason: `Tipo de cálculo [${feeData.calculationType}] inválido. Valores aceites: FLAT, PERCENTAGE, HYBRID.`
      };
    }

    const flatAmount = BigInt(feeData.flatAmount || 0);
    const basisPoints = Number(feeData.basisPoints || 0);

    if (flatAmount < 0n) {
      return { valid: false, reason: 'A parcela fixa da taxa não pode ser negativa.' };
    }

    if (basisPoints < 0 || basisPoints > 2000) {
      // Teto máximo regulamentar: 2000 bps = 20.00%
      return { valid: false, reason: 'A parcela percentual deve estar entre 0 e 2000 pontos-base (0.00% a 20.00%).' };
    }

    if (feeData.minFee !== undefined && feeData.maxFee !== undefined && feeData.maxFee !== null) {
      const minFee = BigInt(feeData.minFee);
      const maxFee = BigInt(feeData.maxFee);

      if (minFee > maxFee) {
        return { valid: false, reason: 'A taxa mínima (minFee) não pode ser superior à taxa máxima (maxFee).' };
      }
    }

    return { valid: true };
  }

  /**
   * Avalia se uma quantia calculada de taxa é válida em relação aos limites teto e piso.
   *
   * @param {bigint} rawCalculatedFee - Valor bruto da comissão calculado em Kwanzas
   * @param {bigint} [minFee=0n] - Piso mínimo
   * @param {bigint|null} [maxFee=null] - Teto máximo
   * @returns {bigint} Montante final ajustado
   */
  clampFeeAmount(rawCalculatedFee, minFee = 0n, maxFee = null) {
    let fee = rawCalculatedFee < 0n ? 0n : rawCalculatedFee;

    if (minFee > 0n && fee < minFee) {
      fee = minFee;
    }

    if (maxFee !== null && maxFee !== undefined && maxFee > 0n && fee > maxFee) {
      fee = maxFee;
    }

    return fee;
  }
}

// Instância singleton da política de taxas
const feesPolicy = new FeesPolicy();

module.exports = feesPolicy;