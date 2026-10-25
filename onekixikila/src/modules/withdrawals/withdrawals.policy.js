const { USER_ROLES } = require('../../shared/constants/roles');
const { USER_STATUSES, WALLET_STATUSES, WITHDRAWAL_STATUSES } = require('../../shared/constants/statuses');
const limitsConfig = require('../../config/limits');

// Papéis com autorização para aprovação ou rejeição de levantamentos da tesouraria
const WITHDRAWAL_MANAGE_ROLES = new Set([
  USER_ROLES.ADMIN,
  USER_ROLES.FINANCIAL_OPERATOR
]);

// Papéis com autorização para auditoria e supervisão de saídas de valor
const WITHDRAWAL_VIEW_ROLES = new Set([
  USER_ROLES.ADMIN,
  USER_ROLES.AUDITOR,
  USER_ROLES.FINANCIAL_OPERATOR
]);

/**
 * Políticas de autorização, integridade financeira e conformidade prudencial KYC
 * para o módulo de Levantamentos de Fundos (Withdrawals) da plataforma OneKixikila.
 */
class WithdrawalsPolicy {
  /**
   * Avalia se um utilizador detém condições para solicitar o levantamento de fundos.
   * Impõe a obrigatoriedade regulatória de KYC verificado (TIER_2_VERIFIED ou TIER_3_ENHANCED),
   * valida a integridade e solvência da carteira e aplica os limites transacionais e diários em Kwanzas (AOA).
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} wallet - Ficha cadastral da carteira
   * @param {bigint} requestedAmount - Montante líquido a receber
   * @param {bigint} totalDebited - Total a debitar incluindo taxas (amount + fee)
   * @param {object} historicalAggregates - { dailyWithdrawnAmount, monthlyWithdrawnAmount }
   * @returns {{ allowed: boolean, reason?: string, statusCode?: number }}
   */
  canRequestWithdrawal(actingUser, wallet, requestedAmount, totalDebited, historicalAggregates = {}) {
    if (!actingUser || !wallet) {
      return { allowed: false, reason: 'Utilizador ou carteira digital não identificado.', statusCode: 400 };
    }

    // 1. Validação do estado cadastral do utilizador
    if (actingUser.status === USER_STATUSES.BLOCKED || actingUser.status === USER_STATUSES.SUSPENDED) {
      return {
        allowed: false,
        reason: `A sua conta encontra-se no estado [${actingUser.status}]. Levantamentos não autorizados.`,
        statusCode: 403
      };
    }

    if (actingUser.status === USER_STATUSES.DEACTIVATED) {
      return { allowed: false, reason: 'Esta conta encontra-se desativada.', statusCode: 403 };
    }

    // 2. Validação da verificação de identidade KYC (Exigência regulatória prudencial)
    const tier = actingUser.identityTier || actingUser.identity_tier || 'TIER_1_UNVERIFIED';
    const tierLimits = limitsConfig.financial.tiers[tier] || limitsConfig.financial.tiers.TIER_1_UNVERIFIED;

    if (!tierLimits.canWithdraw) {
      return {
        allowed: false,
        reason: 'O levantamento de fundos exige a verificação prévia e aprovação da sua identidade oficial (KYC). Submeta o seu Bilhete de Identidade no menu de verificação.',
        statusCode: 403
      };
    }

    // 3. Validação do estado da carteira digital
    if (wallet.status !== WALLET_STATUSES.ACTIVE) {
      return {
        allowed: false,
        reason: `A sua carteira digital encontra-se no estado [${wallet.status}]. Operações de saída bloqueadas.`,
        statusCode: 403
      };
    }

    if (requestedAmount <= 0n) {
      return {
        allowed: false,
        reason: 'O montante de levantamento deve ser estritamente superior a zero.',
        statusCode: 400
      };
    }

    // 4. Verificação de solvência do saldo disponível
    const availableBalance = BigInt(wallet.available_balance || 0);
    if (availableBalance < totalDebited) {
      const missing = totalDebited - availableBalance;
      return {
        allowed: false,
        reason: `Saldo disponível insuficiente para cobrir o valor solicitado acrescido das tarifas. Faltam ${Number(missing).toLocaleString('pt-AO')} Kz.`,
        statusCode: 402
      };
    }

    // 5. Aplicação dos limites operacionais por nível de KYC
    const maxSingle = BigInt(tierLimits.maxSingleWithdrawal || 0);
    if (maxSingle > 0n && requestedAmount > maxSingle) {
      return {
        allowed: false,
        reason: `O valor solicitado excede o limite máximo por levantamento de ${Number(maxSingle).toLocaleString('pt-AO')} Kz para o seu perfil cadastral (${tier}).`,
        statusCode: 422
      };
    }

    const currentDaily = BigInt(historicalAggregates.dailyWithdrawnAmount || 0);
    const maxDaily = BigInt(tierLimits.maxDailyWithdrawal || 0);
    if (maxDaily > 0n && currentDaily + requestedAmount > maxDaily) {
      const remainingDaily = maxDaily > currentDaily ? maxDaily - currentDaily : 0n;
      return {
        allowed: false,
        reason: `Este pedido ultrapassa o seu limite diário restante de ${Number(remainingDaily).toLocaleString('pt-AO')} Kz (Teto: ${Number(maxDaily).toLocaleString('pt-AO')} Kz/dia).`,
        statusCode: 422
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador atuante possui autorização para consultar a ordem de levantamento (Anti-IDOR).
   * O próprio titular ou agentes autorizados de supervisão financeira possuem permissão.
   *
   * @param {object} actingUser
   * @param {object} withdrawalRecord
   * @returns {boolean}
   */
  canViewWithdrawal(actingUser, withdrawalRecord) {
    if (!actingUser || !withdrawalRecord) {
      return false;
    }

    if (WITHDRAWAL_VIEW_ROLES.has(actingUser.role)) {
      return true;
    }

    return actingUser.id === withdrawalRecord.user_id;
  }

  /**
   * Avalia se uma ordem de levantamento pode ser cancelada pelo utilizador titular.
   *
   * @param {object} actingUser
   * @param {object} withdrawalRecord
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canCancelWithdrawal(actingUser, withdrawalRecord) {
    if (!this.canViewWithdrawal(actingUser, withdrawalRecord)) {
      return { allowed: false, reason: 'Acesso não autorizado a este pedido de levantamento.' };
    }

    if (withdrawalRecord.status !== WITHDRAWAL_STATUSES.REQUESTED) {
      return {
        allowed: false,
        reason: `Apenas ordens no estado inicial de solicitação (REQUESTED) podem ser canceladas. Estado atual: [${withdrawalRecord.status}].`
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador possui privilégios de tesouraria para aprovar e liquidar levantamentos.
   *
   * @param {object} actingUser
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canApproveWithdrawal(actingUser) {
    if (!actingUser) {
      return { allowed: false, reason: 'Autenticação necessária.' };
    }

    if (!WITHDRAWAL_MANAGE_ROLES.has(actingUser.role)) {
      return {
        allowed: false,
        reason: 'A deliberação de levantamentos exige privilégios de FINANCIAL_OPERATOR ou ADMIN.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador possui privilégios para rejeitar formalmente um pedido de levantamento.
   *
   * @param {object} actingUser
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canRejectWithdrawal(actingUser) {
    return this.canApproveWithdrawal(actingUser);
  }

  /**
   * Valida as transições de estado permitidas no ciclo de vida de uma ordem de levantamento.
   *
   * @param {string} currentStatus
   * @param {string} newStatus
   * @returns {boolean}
   */
  isValidStatusTransition(currentStatus, newStatus) {
    const validTransitions = {
      REQUESTED: [
        WITHDRAWAL_STATUSES.APPROVED,
        WITHDRAWAL_STATUSES.PROCESSING,
        WITHDRAWAL_STATUSES.SETTLED,
        WITHDRAWAL_STATUSES.REJECTED,
        WITHDRAWAL_STATUSES.CANCELLED
      ],
      APPROVED: [
        WITHDRAWAL_STATUSES.PROCESSING,
        WITHDRAWAL_STATUSES.SETTLED,
        WITHDRAWAL_STATUSES.FAILED,
        WITHDRAWAL_STATUSES.REJECTED
      ],
      PROCESSING: [
        WITHDRAWAL_STATUSES.SETTLED,
        WITHDRAWAL_STATUSES.FAILED,
        WITHDRAWAL_STATUSES.REJECTED
      ],
      SETTLED: [
        WITHDRAWAL_STATUSES.REVERSED
      ],
      REJECTED: [],
      FAILED: [],
      CANCELLED: [],
      REVERSED: []
    };

    const allowed = validTransitions[currentStatus];
    return Boolean(allowed && allowed.includes(newStatus));
  }
}

// Instância singleton da política de levantamentos
const withdrawalsPolicy = new WithdrawalsPolicy();

module.exports = withdrawalsPolicy;