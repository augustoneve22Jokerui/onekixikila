const limitsRepository = require('./limits.repository');
const limitsPolicy = require('./limits.policy');
const AuthorizationError = require('../../shared/errors/authorization-error');
const ValidationError = require('../../shared/errors/validation-error');
const ConflictError = require('../../shared/errors/conflict-error');

/**
 * Serviço de regras de negócio para Gestão, Monitorização Prudencial
 * e Verificação de Limites Operacionais na plataforma OneKixikila.
 */
class LimitsService {
  /**
   * Avalia a conformidade de uma transação financeira pretendida em relação a todos os escopos aplicáveis
   * (Por Transação, Diário e Mensal) com base no nível KYC do utilizador.
   * Lança ConflictError detalhado caso qualquer teto regulamentar seja ultrapassado.
   *
   * @param {object} params
   * @param {string} params.userId - UUID do utilizador
   * @param {string} params.tierCode - 'TIER_1_UNVERIFIED', 'TIER_2_VERIFIED', 'TIER_3_ENHANCED'
   * @param {string} params.operationType - 'DEPOSIT', 'WITHDRAWAL', 'INTERNAL_TRANSFER', etc.
   * @param {number|bigint} params.amount - Montante da operação em Kwanzas inteiros (AOA)
   * @returns {Promise<{ compliant: boolean, limitsChecked: Array<object> }>}
   */
  async assertTransactionCompliance({ userId, tierCode, operationType, amount }) {
    const principalAmount = BigInt(amount);

    if (principalAmount <= 0n) {
      throw ValidationError.invalidValue('amount', 'O montante da operação deve ser superior a zero.');
    }

    const limitsChecked = [];

    // 1. Verificação do limite por transação única (PER_TRANSACTION)
    const perTxRule = await limitsRepository.findLimitRule(tierCode, operationType, 'PER_TRANSACTION');
    if (perTxRule) {
      const evalPerTx = limitsPolicy.evaluateCompliance(perTxRule, principalAmount, 0n, 0);
      limitsChecked.push({
        scope: 'PER_TRANSACTION',
        maxAmount: Number(perTxRule.max_amount),
        compliant: evalPerTx.compliant
      });

      if (!evalPerTx.compliant) {
        throw new ConflictError(evalPerTx.reason, 'LIMIT_PER_TRANSACTION_EXCEEDED');
      }
    }

    // 2. Verificação do limite diário cumulativo (DAILY)
    const dailyRule = await limitsRepository.findLimitRule(tierCode, operationType, 'DAILY');
    if (dailyRule) {
      const dailyStats = await limitsRepository.getUserConsumedVolume(userId, operationType, 'DAILY');
      const evalDaily = limitsPolicy.evaluateCompliance(
        dailyRule,
        principalAmount,
        dailyStats.consumedVolume,
        dailyStats.transactionCount
      );

      limitsChecked.push({
        scope: 'DAILY',
        maxAmount: Number(dailyRule.max_amount),
        consumedToday: Number(dailyStats.consumedVolume),
        compliant: evalDaily.compliant
      });

      if (!evalDaily.compliant) {
        throw new ConflictError(evalDaily.reason, 'DAILY_LIMIT_EXCEEDED');
      }
    }

    // 3. Verificação do limite mensal cumulativo (MONTHLY)
    const monthlyRule = await limitsRepository.findLimitRule(tierCode, operationType, 'MONTHLY');
    if (monthlyRule) {
      const monthlyStats = await limitsRepository.getUserConsumedVolume(userId, operationType, 'MONTHLY');
      const evalMonthly = limitsPolicy.evaluateCompliance(
        monthlyRule,
        principalAmount,
        monthlyStats.consumedVolume,
        monthlyStats.transactionCount
      );

      limitsChecked.push({
        scope: 'MONTHLY',
        maxAmount: Number(monthlyRule.max_amount),
        consumedMonth: Number(monthlyStats.consumedVolume),
        compliant: evalMonthly.compliant
      });

      if (!evalMonthly.compliant) {
        throw new ConflictError(evalMonthly.reason, 'MONTHLY_LIMIT_EXCEEDED');
      }
    }

    return {
      compliant: true,
      limitsChecked
    };
  }

  /**
   * Consulta os limites vigentes e o consumo atual (diário e mensal) de um utilizador específico.
   *
   * @param {string} userId
   * @param {string} tierCode
   * @returns {Promise<Array<object>>}
   */
  async getUserLimitOverview(userId, tierCode) {
    const rules = await limitsRepository.listLimitsByTier(tierCode);
    const overview = [];

    for (const rule of rules) {
      let consumed = 0n;
      let txCount = 0;

      if (rule.scope === 'DAILY' || rule.scope === 'MONTHLY') {
        const stats = await limitsRepository.getUserConsumedVolume(userId, rule.operation_type, rule.scope);
        consumed = stats.consumedVolume;
        txCount = stats.transactionCount;
      }

      const max = BigInt(rule.max_amount);
      const remaining = max > consumed ? max - consumed : 0n;

      overview.push({
        id: rule.id,
        operationType: rule.operation_type,
        scope: rule.scope,
        maxAmount: Number(max),
        consumedAmount: Number(consumed),
        remainingAmount: Number(remaining),
        currency: rule.currency || 'AOA',
        isActive: rule.is_active
      });
    }

    return overview;
  }

  /**
   * Cadastra ou atualiza uma regra de limite operacional (Ação de Governança).
   *
   * @param {object} actingUser - Administrador ou Auditor
   * @param {object} limitData
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async configureLimit(actingUser, limitData, context = {}) {
    const authCheck = limitsPolicy.canManageLimits(actingUser);
    if (!authCheck.allowed) {
      throw new AuthorizationError(authCheck.reason);
    }

    const structureCheck = limitsPolicy.validateLimitStructure(limitData);
    if (!structureCheck.valid) {
      throw new ValidationError(structureCheck.reason);
    }

    const configured = await limitsRepository.upsertLimit(limitData);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'LIMIT_RULE',
        resourceId: configured.id,
        metadata: {
          tierCode: configured.tier_code,
          operationType: configured.operation_type,
          scope: configured.scope,
          maxAmount: configured.max_amount
        }
      });
    }

    return configured;
  }

  /**
   * Lista todas as regras de limites cadastradas na plataforma.
   *
   * @param {object} actingUser
   * @returns {Promise<Array<object>>}
   */
  async listAllLimits(actingUser) {
    const authCheck = limitsPolicy.canManageLimits(actingUser);
    if (!authCheck.allowed) {
      throw new AuthorizationError(authCheck.reason);
    }

    return limitsRepository.listAllLimits();
  }
}

// Instância singleton do serviço de limites
const limitsService = new LimitsService();

module.exports = limitsService;