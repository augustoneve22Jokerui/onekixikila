const feesRepository = require('./fees.repository');
const feesPolicy = require('./fees.policy');
const { roundingService, ROUNDING_MODES } = require('../../shared/finance/rounding');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ValidationError = require('../../shared/errors/validation-error');
const ConflictError = require('../../shared/errors/conflict-error');

/**
 * Serviço de regras de negócio para Gestão, Configuração e Cálculo Determinístico
 * de Taxas e Comissões da plataforma OneKixikila.
 */
class FeesService {
  /**
   * Calcula o montante exato de tarifa aplicável a uma operação financeira em Kwanzas (AOA).
   * Aplica com segurança parcelas fixas, proporcionais (pontos-base), arredondamento bancário
   * e limites de piso e teto (minFee / maxFee).
   *
   * @param {string} operationType - 'DEPOSIT', 'WITHDRAWAL', 'INTERNAL_TRANSFER', 'CONTRIBUTION_PAYMENT', etc.
   * @param {number|bigint} principalAmount - Montante da operação em Kwanzas inteiros
   * @returns {Promise<{
   *   feeCode: string,
   *   calculationType: string,
   *   feeAmount: number,
   *   netAmount: number,
   *   totalRequired: number,
   *   currency: string,
   *   breakdown: { flatAmount: number, percentageAmount: number }
   * }>}
   */
  async calculateFee(operationType, principalAmount) {
    const principalBigInt = BigInt(principalAmount);

    if (principalBigInt < 0n) {
      throw ValidationError.invalidValue('principalAmount', 'O montante base não pode ser negativo.');
    }

    // Busca a regra tarifária vigente aplicável
    const feeRule = await feesRepository.findActiveByOperationType(operationType.toUpperCase());

    // Se não houver regra de taxa cadastrada, considera isenção total (taxa = 0 Kz)
    if (!feeRule) {
      return {
        feeCode: 'ZERO_FEE_DEFAULT',
        calculationType: 'FLAT',
        feeAmount: 0,
        netAmount: Number(principalBigInt),
        totalRequired: Number(principalBigInt),
        currency: 'AOA',
        breakdown: { flatAmount: 0, percentageAmount: 0 }
      };
    }

    let flatComponent = 0n;
    let percentageComponent = 0n;

    if (feeRule.calculation_type === 'FLAT' || feeRule.calculation_type === 'HYBRID') {
      flatComponent = BigInt(feeRule.flat_amount || 0);
    }

    if (feeRule.calculation_type === 'PERCENTAGE' || feeRule.calculation_type === 'HYBRID') {
      const bps = Number(feeRule.basis_points || 0);
      percentageComponent = roundingService.calculateBasisPointsFee(
        principalBigInt,
        bps,
        ROUNDING_MODES.HALF_EVEN
      );
    }

    const rawTotalFee = flatComponent + percentageComponent;

    // Aplica limites de piso (minFee) e teto (maxFee)
    const minFee = BigInt(feeRule.min_fee || 0);
    const maxFee = feeRule.max_fee !== null ? BigInt(feeRule.max_fee) : null;
    const finalFee = feesPolicy.clampFeeAmount(rawTotalFee, minFee, maxFee);

    // Para levantamentos/pagamentos: totalRequired = principal + fee; para depósitos líquidos: netAmount = principal - fee
    const netAmount = principalBigInt >= finalFee ? principalBigInt - finalFee : 0n;
    const totalRequired = principalBigInt + finalFee;

    return {
      feeCode: feeRule.fee_code,
      calculationType: feeRule.calculation_type,
      feeAmount: Number(finalFee),
      netAmount: Number(netAmount),
      totalRequired: Number(totalRequired),
      currency: feeRule.currency || 'AOA',
      breakdown: {
        flatAmount: Number(flatComponent),
        percentageAmount: Number(percentageComponent)
      }
    };
  }

  /**
   * Cria uma nova tarifa na matriz institucional da plataforma.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} feeData - Dados validados
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async createFee(actingUser, feeData, context = {}) {
    const authCheck = feesPolicy.canManageFees(actingUser);
    if (!authCheck.allowed) {
      throw new AuthorizationError(authCheck.reason);
    }

    const structureCheck = feesPolicy.validateFeeStructure(feeData);
    if (!structureCheck.valid) {
      throw new ValidationError(structureCheck.reason);
    }

    const existing = await feesRepository.findByCode(feeData.feeCode);
    if (existing) {
      throw new ConflictError(`Já existe uma tarifa cadastrada com o código [${feeData.feeCode}].`);
    }

    const created = await feesRepository.createFee(feeData);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'CREATE',
        resourceType: 'FEE',
        resourceId: created.id,
        metadata: {
          feeCode: created.fee_code,
          operationType: created.operation_type,
          calculationType: created.calculation_type,
          basisPoints: created.basis_points,
          flatAmount: created.flat_amount
        }
      });
    }

    return created;
  }

  /**
   * Atualiza os parâmetros de uma tarifa existente, gerando uma nova versão auditável.
   *
   * @param {object} actingUser
   * @param {string} feeCode
   * @param {object} updateData
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async updateFee(actingUser, feeCode, updateData, context = {}) {
    const authCheck = feesPolicy.canManageFees(actingUser);
    if (!authCheck.allowed) {
      throw new AuthorizationError(authCheck.reason);
    }

    const existing = await feesRepository.findByCode(feeCode);
    if (!existing) {
      throw new NotFoundError.resource('Tarifa', feeCode);
    }

    const updated = await feesRepository.updateFee(feeCode, updateData);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'FEE',
        resourceId: existing.id,
        oldValues: {
          calculationType: existing.calculation_type,
          flatAmount: existing.flat_amount,
          basisPoints: existing.basis_points,
          version: existing.version
        },
        newValues: {
          ...updateData,
          version: updated.version
        }
      });
    }

    return updated;
  }

  /**
   * Consulta a lista de todas as tarifas cadastradas na plataforma.
   *
   * @param {boolean|null} [onlyActive=null]
   * @returns {Promise<Array<object>>}
   */
  async listAllFees(onlyActive = null) {
    return feesRepository.listAllFees(onlyActive);
  }
}

// Instância singleton do serviço de taxas
const feesService = new FeesService();

module.exports = feesService;