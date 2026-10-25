const { USER_ROLES } = require('../../shared/constants/roles');
const { USER_STATUSES, WALLET_STATUSES, DEPOSIT_STATUSES } = require('../../shared/constants/statuses');
const limitsConfig = require('../../config/limits');

/**
 * Políticas de autorização, controlo de limites operacionais em Kwanzas (AOA) por nível KYC
 * e integridade do ciclo de vida de Depósitos na carteira digital da OneKixikila.
 */
class DepositsPolicy {
  /**
   * Avalia se um utilizador pode iniciar um novo pedido de depósito na sua carteira.
   * Valida estado da conta, integridade da carteira, limites por transação e limites diários/mensais.
   *
   * @param {object} user - Utilizador autenticado (req.user)
   * @param {object} wallet - Ficha da carteira do utilizador
   * @param {number|bigint} amount - Montante pretendido em Kwanzas inteiros (AOA)
   * @param {object} historicalAggregates - Volumes acumulados { dailyDepositedAmount, monthlyDepositedAmount }
   * @returns {{ allowed: boolean, reason?: string, statusCode?: number }}
   */
  canCreateDeposit(user, wallet, amount, historicalAggregates = {}) {
    if (!user || !wallet) {
      return { allowed: false, reason: 'Utilizador ou carteira digital não identificados.', statusCode: 400 };
    }

    // 1. Validação do estado cadastral do utilizador
    if (user.status === USER_STATUSES.BLOCKED || user.status === USER_STATUSES.SUSPENDED) {
      return {
        allowed: false,
        reason: `A sua conta encontra-se no estado [${user.status}]. Depósitos não autorizados.`,
        statusCode: 403
      };
    }

    if (user.status === USER_STATUSES.DEACTIVATED) {
      return { allowed: false, reason: 'Esta conta encontra-se desativada.', statusCode: 403 };
    }

    // 2. Validação do estado da carteira digital
    if (wallet.status !== WALLET_STATUSES.ACTIVE) {
      return {
        allowed: false,
        reason: `A sua carteira interna encontra-se no estado [${wallet.status}]. Não é possível receber depósitos.`,
        statusCode: 403
      };
    }

    const depositAmount = BigInt(amount);

    if (depositAmount <= 0n) {
      return {
        allowed: false,
        reason: 'O montante do depósito deve ser estritamente superior a zero.',
        statusCode: 400
      };
    }

    // 3. Aplicação da matriz oficial de limites KYC (Configuração por Tier)
    const tier = user.identityTier || user.identity_tier || 'TIER_1_UNVERIFIED';
    const tierLimits =
      limitsConfig.financial.tiers[tier] || limitsConfig.financial.tiers.TIER_1_UNVERIFIED;

    // Limite máximo por transação única
    const maxSingle = BigInt(tierLimits.maxSingleDeposit);
    if (depositAmount > maxSingle) {
      return {
        allowed: false,
        reason: `O valor excede o limite máximo por depósito de ${Number(maxSingle).toLocaleString('pt-AO')} Kz para o seu nível cadastral (${tier}). Complete a verificação de identidade (KYC) para aumentar o seu teto.`,
        statusCode: 422
      };
    }

    // Limite diário cumulativo
    const currentDaily = BigInt(historicalAggregates.dailyDepositedAmount || 0);
    const maxDaily = BigInt(tierLimits.maxDailyDeposit);
    if (currentDaily + depositAmount > maxDaily) {
      const remainingDaily = maxDaily > currentDaily ? maxDaily - currentDaily : 0n;
      return {
        allowed: false,
        reason: `Este depósito excede o seu limite diário restante de ${Number(remainingDaily).toLocaleString('pt-AO')} Kz (Teto: ${Number(maxDaily).toLocaleString('pt-AO')} Kz/dia).`,
        statusCode: 422
      };
    }

    // Limite mensal cumulativo
    const currentMonthly = BigInt(historicalAggregates.monthlyDepositedAmount || 0);
    const maxMonthly = BigInt(tierLimits.maxMonthlyVolume);
    if (currentMonthly + depositAmount > maxMonthly) {
      const remainingMonthly = maxMonthly > currentMonthly ? maxMonthly - currentMonthly : 0n;
      return {
        allowed: false,
        reason: `Este depósito ultrapassa o volume mensal disponível de ${Number(remainingMonthly).toLocaleString('pt-AO')} Kz para o seu perfil.`,
        statusCode: 422
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se determinado utilizador detém permissão para visualizar a ficha de um depósito (Anti-IDOR).
   *
   * @param {object} actingUser
   * @param {object} depositRecord
   * @returns {boolean}
   */
  canViewDeposit(actingUser, depositRecord) {
    if (!actingUser || !depositRecord) {
      return false;
    }

    if (actingUser.role === USER_ROLES.ADMIN || actingUser.role === USER_ROLES.AUDITOR) {
      return true;
    }

    return actingUser.id === depositRecord.user_id;
  }

  /**
   * Avalia se um depósito pode ser cancelado pelo utilizador antes da liquidação.
   *
   * @param {object} actingUser
   * @param {object} depositRecord
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canCancelDeposit(actingUser, depositRecord) {
    if (!this.canViewDeposit(actingUser, depositRecord)) {
      return { allowed: false, reason: 'Acesso não autorizado ao depósito.' };
    }

    if (
      depositRecord.status !== DEPOSIT_STATUSES.CREATED &&
      depositRecord.status !== DEPOSIT_STATUSES.PENDING_PAYMENT
    ) {
      return {
        allowed: false,
        reason: `Depósitos no estado [${depositRecord.status}] não podem ser cancelados.`
      };
    }

    return { allowed: true };
  }

  /**
   * Valida se uma transição de estado no ciclo de vida do depósito é legítima.
   *
   * @param {string} currentStatus
   * @param {string} newStatus
   * @returns {boolean}
   */
  isValidStatusTransition(currentStatus, newStatus) {
    const validTransitions = {
      CREATED: ['PENDING_PAYMENT', 'PROCESSING', 'CONFIRMED', 'CANCELLED', 'EXPIRED'],
      PENDING_PAYMENT: ['PROCESSING', 'CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED'],
      PROCESSING: ['CONFIRMED', 'SETTLED', 'FAILED', 'RECONCILING'],
      CONFIRMED: ['SETTLED', 'IN_DISPUTE', 'REVERSED'],
      SETTLED: ['IN_DISPUTE', 'REVERSED'],
      FAILED: [],
      EXPIRED: [],
      CANCELLED: [],
      RECONCILING: ['CONFIRMED', 'SETTLED', 'FAILED'],
      IN_DISPUTE: ['SETTLED', 'REVERSED'],
      REVERSED: []
    };

    const allowed = validTransitions[currentStatus];
    return Boolean(allowed && allowed.includes(newStatus));
  }
}

// Instância singleton da política de depósitos
const depositsPolicy = new DepositsPolicy();

module.exports = depositsPolicy;