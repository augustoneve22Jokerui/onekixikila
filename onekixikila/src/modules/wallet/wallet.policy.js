const { USER_ROLES } = require('../../shared/constants/roles');
const { WALLET_STATUSES } = require('../../shared/constants/statuses');

// Papéis com autorização para auditoria e supervisão ampla de carteiras
const WALLET_AUDIT_ROLES = new Set([
  USER_ROLES.ADMIN,
  USER_ROLES.AUDITOR,
  USER_ROLES.FINANCIAL_OPERATOR
]);

// Papéis com permissão para alterar o estado operacional de uma carteira (congelar/descongelar)
const WALLET_MANAGE_STATUS_ROLES = new Set([
  USER_ROLES.ADMIN,
  USER_ROLES.AUDITOR
]);

/**
 * Políticas de autorização, integridade de saldos e salvaguardas Anti-IDOR
 * para o módulo de Carteira Interna (Wallet) da plataforma OneKixikila.
 */
class WalletPolicy {
  /**
   * Avalia se o utilizador atuante detém permissão para consultar os saldos e dados da carteira (Anti-IDOR).
   * O próprio titular pode consultar a sua carteira; agentes com papéis administrativos
   * (ADMIN, AUDITOR, FINANCIAL_OPERATOR) possuem autorização de supervisão e auditoria.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} targetUserId - UUID do titular da carteira
   * @returns {boolean}
   */
  canViewWallet(actingUser, targetUserId) {
    if (!actingUser || !targetUserId) {
      return false;
    }

    if (WALLET_AUDIT_ROLES.has(actingUser.role)) {
      return true;
    }

    return actingUser.id === targetUserId;
  }

  /**
   * Avalia se o utilizador pode visualizar o recibo/comprovativo de uma transação contábil.
   * Acesso reservado ao participante titular da conta envolvida ou a auditores do sistema.
   *
   * @param {object} actingUser
   * @param {object} receiptData
   * @returns {boolean}
   */
  canViewReceipt(actingUser, receiptData) {
    if (!actingUser || !receiptData) {
      return false;
    }

    if (WALLET_AUDIT_ROLES.has(actingUser.role)) {
      return true;
    }

    return Boolean(receiptData.user_id && actingUser.id === receiptData.user_id);
  }

  /**
   * Avalia se o utilizador atuante detém autorização para congelar ou descongelar uma carteira.
   *
   * @param {object} actingUser
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canManageWalletStatus(actingUser) {
    if (!actingUser) {
      return { allowed: false, reason: 'Autenticação necessária.' };
    }

    if (!WALLET_MANAGE_STATUS_ROLES.has(actingUser.role)) {
      return {
        allowed: false,
        reason: 'A alteração cautelar do estado da carteira exige privilégios de AUDITOR ou ADMIN.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador possui privilégios para listar a carteira de todos os clientes no painel.
   *
   * @param {object} actingUser
   * @returns {boolean}
   */
  canAuditWallets(actingUser) {
    if (!actingUser) {
      return false;
    }
    return WALLET_AUDIT_ROLES.has(actingUser.role);
  }

  /**
   * Valida as transições de estado permitidas no ciclo de vida da carteira digital.
   *
   * @param {string} currentStatus
   * @param {string} newStatus
   * @returns {boolean}
   */
  isValidStatusTransition(currentStatus, newStatus) {
    const validTransitions = {
      ACTIVE: [WALLET_STATUSES.FROZEN, WALLET_STATUSES.SUSPENDED, WALLET_STATUSES.CLOSED],
      FROZEN: [WALLET_STATUSES.ACTIVE, WALLET_STATUSES.SUSPENDED, WALLET_STATUSES.CLOSED],
      SUSPENDED: [WALLET_STATUSES.ACTIVE, WALLET_STATUSES.CLOSED],
      CLOSED: []
    };

    const allowed = validTransitions[currentStatus];
    return Boolean(allowed && allowed.includes(newStatus));
  }
}

// Instância singleton da política de carteiras
const walletPolicy = new WalletPolicy();

module.exports = walletPolicy;