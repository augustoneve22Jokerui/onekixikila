const { USER_ROLES } = require('../../shared/constants/roles');
const { USER_STATUSES, WALLET_STATUSES, TRANSFER_STATUSES } = require('../../shared/constants/statuses');
const limitsConfig = require('../../config/limits');

// Papéis com autorização para auditoria e supervisão de transferências
const TRANSFER_AUDIT_ROLES = new Set([
  USER_ROLES.ADMIN,
  USER_ROLES.AUDITOR,
  USER_ROLES.FINANCIAL_OPERATOR
]);

/**
 * Políticas de autorização, integridade de saldos e conformidade prudencial KYC
 * para o módulo de Transferências Internas entre Carteiras (P2P) da plataforma OneKixikila.
 */
class TransfersPolicy {
  /**
   * Avalia se uma transferência direta entre membros pode ser autorizada e executada.
   * Valida contas de remetente e destinatário, prevenção de auto-transferência, solvência do saldo
   * e aplicação dos limites por transação e diários em Kwanzas (AOA) de acordo com o nível KYC.
   *
   * @param {object} actingUser - Utilizador autenticado remetente (req.user)
   * @param {object} senderWallet - Carteira digital do remetente
   * @param {object} recipientUser - Dados do utilizador destinatário
   * @param {object} recipientWallet - Carteira digital do destinatário
   * @param {bigint} transferAmount - Montante nominal a transferir
   * @param {bigint} totalRequired - Montante total exigido incluindo eventuais tarifas
   * @param {object} historicalAggregates - { dailyTransferredAmount, monthlyTransferredAmount }
   * @returns {{ allowed: boolean, reason?: string, statusCode?: number }}
   */
  canTransferFunds(
    actingUser,
    senderWallet,
    recipientUser,
    recipientWallet,
    transferAmount,
    totalRequired,
    historicalAggregates = {}
  ) {
    if (!actingUser || !senderWallet || !recipientUser || !recipientWallet) {
      return { allowed: false, reason: 'Parâmetros cadastrais incompletos para a transferência.', statusCode: 400 };
    }

    // 1. Validação do estado cadastral do remetente
    if (actingUser.status === USER_STATUSES.BLOCKED || actingUser.status === USER_STATUSES.SUSPENDED) {
      return {
        allowed: false,
        reason: `A sua conta encontra-se no estado [${actingUser.status}]. Transferências financeiras não permitidas.`,
        statusCode: 403
      };
    }

    if (actingUser.status === USER_STATUSES.DEACTIVATED) {
      return { allowed: false, reason: 'Esta conta encontra-se desativada.', statusCode: 403 };
    }

    // 2. Prevenção de auto-transferência
    if (actingUser.id === recipientUser.id || senderWallet.id === recipientWallet.id) {
      return {
        allowed: false,
        reason: 'Não é permitido realizar transferências para a sua própria conta.',
        statusCode: 409
      };
    }

    // 3. Validação do estado da carteira do remetente
    if (senderWallet.status !== WALLET_STATUSES.ACTIVE) {
      return {
        allowed: false,
        reason: `A sua carteira digital encontra-se no estado [${senderWallet.status}]. Operações de débito bloqueadas.`,
        statusCode: 403
      };
    }

    // 4. Validação da conta e carteira do destinatário
    if (recipientUser.status === USER_STATUSES.BLOCKED || recipientUser.status === USER_STATUSES.DEACTIVATED) {
      return {
        allowed: false,
        reason: 'A conta do destinatário encontra-se indisponível ou bloqueada para recebimento de valores.',
        statusCode: 409
      };
    }

    if (recipientWallet.status !== WALLET_STATUSES.ACTIVE) {
      return {
        allowed: false,
        reason: `A carteira digital do destinatário encontra-se no estado [${recipientWallet.status}]. Recebimento bloqueado.`,
        statusCode: 409
      };
    }

    if (transferAmount <= 0n) {
      return {
        allowed: false,
        reason: 'O montante da transferência deve ser estritamente superior a zero.',
        statusCode: 400
      };
    }

    // 5. Verificação de solvência do saldo disponível do remetente
    const availableBalance = BigInt(senderWallet.available_balance || 0);
    if (availableBalance < totalRequired) {
      const missing = totalRequired - availableBalance;
      return {
        allowed: false,
        reason: `Saldo disponível insuficiente para realizar a transferência. Faltam ${Number(missing).toLocaleString('pt-AO')} Kz.`,
        statusCode: 402
      };
    }

    // 6. Aplicação da matriz oficial de limites KYC para transferências P2P
    const tier = actingUser.identityTier || actingUser.identity_tier || 'TIER_1_UNVERIFIED';
    const tierLimits = limitsConfig.financial.tiers[tier] || limitsConfig.financial.tiers.TIER_1_UNVERIFIED;

    // Limite máximo por transferência única
    const maxSingle = BigInt(tierLimits.maxSingleTransfer || 0);
    if (maxSingle > 0n && transferAmount > maxSingle) {
      return {
        allowed: false,
        reason: `O valor excede o limite máximo por transferência de ${Number(maxSingle).toLocaleString('pt-AO')} Kz para o seu perfil (${tier}). Submeta a sua verificação de identidade para aumentar o seu teto.`,
        statusCode: 422
      };
    }

    // Limite diário cumulativo de transferências
    const currentDaily = BigInt(historicalAggregates.dailyTransferredAmount || 0);
    const maxDaily = BigInt(tierLimits.maxDailyTransfer || 0);
    if (maxDaily > 0n && currentDaily + transferAmount > maxDaily) {
      const remainingDaily = maxDaily > currentDaily ? maxDaily - currentDaily : 0n;
      return {
        allowed: false,
        reason: `Esta operação ultrapassa o seu limite diário restante de transferência de ${Number(remainingDaily).toLocaleString('pt-AO')} Kz (Teto: ${Number(maxDaily).toLocaleString('pt-AO')} Kz/dia).`,
        statusCode: 422
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador atuante detém permissão para visualizar o comprovativo da transferência (Anti-IDOR).
   * O remetente, o destinatário ou agentes autorizados de supervisão financeira possuem permissão legítima.
   *
   * @param {object} actingUser
   * @param {object} transferRecord
   * @returns {boolean}
   */
  canViewTransfer(actingUser, transferRecord) {
    if (!actingUser || !transferRecord) {
      return false;
    }

    if (TRANSFER_AUDIT_ROLES.has(actingUser.role)) {
      return true;
    }

    return actingUser.id === transferRecord.sender_user_id || actingUser.id === transferRecord.recipient_user_id;
  }

  /**
   * Valida as transições de estado permitidas para um registro de transferência interna.
   *
   * @param {string} currentStatus
   * @param {string} newStatus
   * @returns {boolean}
   */
  isValidStatusTransition(currentStatus, newStatus) {
    const validTransitions = {
      PENDING: [
        TRANSFER_STATUSES.COMPLETED,
        TRANSFER_STATUSES.FAILED,
        TRANSFER_STATUSES.REVERSED
      ],
      COMPLETED: [
        TRANSFER_STATUSES.REVERSED
      ],
      FAILED: [],
      REVERSED: []
    };

    const allowed = validTransitions[currentStatus];
    return Boolean(allowed && allowed.includes(newStatus));
  }
}

// Instância singleton da política de transferências
const transfersPolicy = new TransfersPolicy();

module.exports = transfersPolicy;