const { USER_ROLES } = require('../../shared/constants/roles');

// Escopos temporais e transacionais autorizados para limites operacionais
const ALLOWED_LIMIT_SCOPES = new Set(['PER_TRANSACTION', 'DAILY', 'MONTHLY']);

// Níveis canónicos de verificação de identidade KYC (Tiers)
const ALLOWED_KYC_TIERS = new Set(['TIER_1_UNVERIFIED', 'TIER_2_VERIFIED', 'TIER_3_ENHANCED']);

// Tipos de operações financeiras sujeitas a limite de valor ou contagem
const ALLOWED_LIMIT_OPERATIONS = new Set([
  'DEPOSIT',
  'WITHDRAWAL',
  'INTERNAL_TRANSFER',
  'CONTRIBUTION_PAYMENT',
  'ROTATION_PAYOUT'
]);

// Papéis administrativos com permissão formal para gerir a matriz de limites da plataforma
const LIMITS_MANAGEMENT_ROLES = new Set([USER_ROLES.ADMIN, USER_ROLES.AUDITOR, USER_ROLES.FINANCIAL_OPERATOR]);

/**
 * Políticas de autorização, integridade regulatória e conformidade prudencial
 * para a matriz de Limites Financeiros da plataforma OneKixikila.
 */
class LimitsPolicy {
  /**
   * Avalia se o utilizador atuante detém permissão para configurar ou atualizar os limites do sistema.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canManageLimits(actingUser) {
    if (!actingUser) {
      return { allowed: false, reason: 'Autenticação necessária.' };
    }

    if (!LIMITS_MANAGEMENT_ROLES.has(actingUser.role)) {
      return {
        allowed: false,
        reason: 'A gestão da matriz de limites financeiros exige privilégios de ADMIN, AUDITOR ou FINANCIAL_OPERATOR.'
      };
    }

    return { allowed: true };
  }

  /**
   * Valida a integridade da estrutura de um limite financeiro antes da persistência.
   *
   * @param {object} limitData
   * @returns {{ valid: boolean, reason?: string }}
   */
  validateLimitStructure(limitData) {
    if (!limitData) {
      return { valid: false, reason: 'Dados do limite vazios ou não fornecidos.' };
    }

    if (!ALLOWED_KYC_TIERS.has(limitData.tierCode)) {
      return {
        valid: false,
        reason: `Nível de KYC [${limitData.tierCode}] inválido. Valores aceites: ${Array.from(ALLOWED_KYC_TIERS).join(', ')}.`
      };
    }

    if (!ALLOWED_LIMIT_OPERATIONS.has(limitData.operationType)) {
      return {
        valid: false,
        reason: `Operação financeira [${limitData.operationType}] não suportada para aplicação de limites.`
      };
    }

    if (!ALLOWED_LIMIT_SCOPES.has(limitData.scope)) {
      return {
        valid: false,
        reason: `Escopo [${limitData.scope}] inválido. Valores aceites: PER_TRANSACTION, DAILY, MONTHLY.`
      };
    }

    const maxAmount = BigInt(limitData.maxAmount || 0);
    if (maxAmount <= 0n) {
      return { valid: false, reason: 'O valor máximo (maxAmount) deve ser estritamente superior a zero.' };
    }

    if (limitData.maxCount !== undefined && limitData.maxCount !== null) {
      const maxCount = Number(limitData.maxCount);
      if (!Number.isInteger(maxCount) || maxCount <= 0) {
        return { valid: false, reason: 'A quantidade máxima de transações (maxCount) deve ser um inteiro positivo.' };
      }
    }

    return { valid: true };
  }

  /**
   * Avalia se uma transação pretendida cumpre os tetos da regra de limite aplicável.
   *
   * @param {object} limitRule - Registo da tabela limits
   * @param {number|bigint} transactionAmount - Montante pretendido em Kwanzas
   * @param {number|bigint} [currentAggregatedVolume=0] - Volume já consumido na janela temporal
   * @param {number} [currentTransactionCount=0] - Total de transações já efetuadas na janela
   * @returns {{ compliant: boolean, reason?: string, remainingAmount?: bigint }}
   */
  evaluateCompliance(limitRule, transactionAmount, currentAggregatedVolume = 0n, currentTransactionCount = 0) {
    if (!limitRule || !limitRule.is_active) {
      return { compliant: true };
    }

    const amount = BigInt(transactionAmount);
    const maxAmount = BigInt(limitRule.max_amount);
    const consumed = BigInt(currentAggregatedVolume);

    if (limitRule.scope === 'PER_TRANSACTION') {
      if (amount > maxAmount) {
        return {
          compliant: false,
          reason: `O montante excede o teto por transação de ${Number(maxAmount).toLocaleString('pt-AO')} Kz.`,
          remainingAmount: maxAmount
        };
      }
      return { compliant: true, remainingAmount: maxAmount - amount };
    }

    // Para escopos cumulativos (DAILY / MONTHLY)
    if (consumed + amount > maxAmount) {
      const remaining = maxAmount > consumed ? maxAmount - consumed : 0n;
      const scopeLabel = limitRule.scope === 'DAILY' ? 'diário' : 'mensal';
      return {
        compliant: false,
        reason: `A operação excede o limite ${scopeLabel} restante de ${Number(remaining).toLocaleString('pt-AO')} Kz (Teto: ${Number(maxAmount).toLocaleString('pt-AO')} Kz).`,
        remainingAmount: remaining
      };
    }

    // Validação opcional de quantidade máxima de transações
    if (limitRule.max_count !== null && limitRule.max_count !== undefined) {
      const maxCount = Number(limitRule.max_count);
      if (currentTransactionCount + 1 > maxCount) {
        return {
          compliant: false,
          reason: `Atingiu o número máximo permitido de ${maxCount} operações para o período.`
        };
      }
    }

    return { compliant: true, remainingAmount: maxAmount - (consumed + amount) };
  }
}

// Instância singleton da política de limites
const limitsPolicy = new LimitsPolicy();

module.exports = limitsPolicy;