const { USER_ROLES } = require('../../shared/constants/roles');
const { ROTATION_STATUSES, GROUP_STATUSES } = require('../../shared/constants/statuses');

// Papéis com autorização administrativa para intervenção em desembolsos financeiros
const PAYOUT_ADMIN_ROLES = new Set([
  USER_ROLES.ADMIN,
  USER_ROLES.AUDITOR,
  USER_ROLES.FINANCIAL_OPERATOR
]);

/**
 * Políticas de autorização, integridade de rotações e regras prudenciais
 * para o módulo de Desembolsos e Payouts de Kixikila da plataforma OneKixikila.
 */
class PayoutsPolicy {
  /**
   * Avalia se a operação de desembolso do bolo da Kixikila pode ser disparada.
   * Valida papéis de governança (Líder titular ou Administração), estado operacional do grupo,
   * integridade do turno de rotação e elegibilidade da carteira do beneficiário.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} rotationDetails - Dados consolidados do turno e beneficiário (findRotationWithDetails)
   * @returns {{ allowed: boolean, reason?: string, statusCode?: number }}
   */
  canExecutePayout(actingUser, rotationDetails) {
    if (!actingUser || !rotationDetails) {
      return { allowed: false, reason: 'Utilizador ou turno de rotação não identificado.', statusCode: 400 };
    }

    const isGroupLeader = actingUser.id === rotationDetails.leader_id;
    const isFinancialAdmin = PAYOUT_ADMIN_ROLES.has(actingUser.role);

    // 1. Apenas o Líder titular do grupo ou administradores financeiros possuem poder de desembolso
    if (!isGroupLeader && !isFinancialAdmin) {
      return {
        allowed: false,
        reason: 'Apenas o Líder titular do grupo ou um Operador Financeiro podem autorizar a entrega do bolo da Kixikila.',
        statusCode: 403
      };
    }

    // 2. Validação do estado operacional do grupo
    if (rotationDetails.group_status !== GROUP_STATUSES.ACTIVE) {
      return {
        allowed: false,
        reason: `O grupo encontra-se no estado [${rotationDetails.group_status}]. Desembolsos só podem ocorrer em grupos ativos.`,
        statusCode: 409
      };
    }

    // 3. Validação do estado do turno de rotação
    if (rotationDetails.status === ROTATION_STATUSES.PAID_OUT) {
      return {
        allowed: false,
        reason: 'O bolo financeiro deste turno de Kixikila já foi integralmente pago e liquidado.',
        statusCode: 409
      };
    }

    if (rotationDetails.status === ROTATION_STATUSES.CANCELLED) {
      return {
        allowed: false,
        reason: 'Este turno de rotação foi formalmente cancelado.',
        statusCode: 409
      };
    }

    if (rotationDetails.status === ROTATION_STATUSES.SKIPPED) {
      return {
        allowed: false,
        reason: 'Este desembolso encontra-se retido preventivamente. É necessário libertar o turno antes da liquidação.',
        statusCode: 409
      };
    }

    // 4. Verificação da existência de beneficiário homologado
    if (!rotationDetails.beneficiary_user_id) {
      return {
        allowed: false,
        reason: 'Nenhum membro participante foi atribuído como beneficiário deste turno da Kixikila.',
        statusCode: 422
      };
    }

    // 5. Verificação da carteira digital de destino
    if (!rotationDetails.beneficiary_wallet_id) {
      return {
        allowed: false,
        reason: 'O beneficiário atribuído não possui uma carteira digital configurada na plataforma.',
        statusCode: 422
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador atuante detém autorização para consultar a ficha de desembolso (Anti-IDOR).
   * O beneficiário do turno, a liderança do grupo ou auditores possuem permissão legítima.
   *
   * @param {object} actingUser
   * @param {object} payoutRecord
   * @param {boolean} [isGroupLeader=false]
   * @returns {boolean}
   */
  canViewPayout(actingUser, payoutRecord, isGroupLeader = false) {
    if (!actingUser || !payoutRecord) {
      return false;
    }

    if (PAYOUT_ADMIN_ROLES.has(actingUser.role)) {
      return true;
    }

    if (actingUser.id === payoutRecord.beneficiary_user_id) {
      return true;
    }

    return Boolean(isGroupLeader);
  }

  /**
   * Avalia se o utilizador pode reter preventivamente um desembolso em caso de disputa ou litígio.
   *
   * @param {object} actingUser
   * @param {object} group
   * @param {object} payoutRecord
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canHoldPayout(actingUser, group, payoutRecord) {
    if (!actingUser || !group || !payoutRecord) {
      return { allowed: false, reason: 'Parâmetros insuficientes para retenção de desembolso.' };
    }

    const isGroupLeader = actingUser.id === group.leader_id || actingUser.id === group.creator_id;
    const isFinancialAdmin = PAYOUT_ADMIN_ROLES.has(actingUser.role);

    if (!isGroupLeader && !isFinancialAdmin) {
      return {
        allowed: false,
        reason: 'A retenção preventiva de um turno de Kixikila é restrita à liderança do grupo ou à auditoria.'
      };
    }

    if (payoutRecord.status === ROTATION_STATUSES.PAID_OUT) {
      return {
        allowed: false,
        reason: 'Não é possível reter um bolo de Kixikila que já foi desembolsado e creditado na carteira.'
      };
    }

    if (payoutRecord.status === ROTATION_STATUSES.CANCELLED) {
      return {
        allowed: false,
        reason: 'Turno cancelado não comporta retenção.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador pode libertar um turno de desembolso previamente retido.
   *
   * @param {object} actingUser
   * @param {object} group
   * @param {object} payoutRecord
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canReleasePayout(actingUser, group, payoutRecord) {
    if (!actingUser || !group || !payoutRecord) {
      return { allowed: false, reason: 'Parâmetros insuficientes para libertação de desembolso.' };
    }

    const isGroupLeader = actingUser.id === group.leader_id || actingUser.id === group.creator_id;
    const isFinancialAdmin = PAYOUT_ADMIN_ROLES.has(actingUser.role);

    if (!isGroupLeader && !isFinancialAdmin) {
      return {
        allowed: false,
        reason: 'Apenas o Líder titular ou um Auditor podem libertar um turno retido.'
      };
    }

    if (payoutRecord.status !== ROTATION_STATUSES.SKIPPED) {
      return {
        allowed: false,
        reason: `Apenas turnos em pausa/retenção (SKIPPED) podem ser libertados. Estado atual: [${payoutRecord.status}].`
      };
    }

    return { allowed: true };
  }

  /**
   * Valida as transições de estado permitidas para um turno de rotação.
   *
   * @param {string} currentStatus
   * @param {string} newStatus
   * @returns {boolean}
   */
  isValidStatusTransition(currentStatus, newStatus) {
    const validTransitions = {
      PENDING: ['READY_FOR_PAYOUT', 'SKIPPED', 'CANCELLED'],
      READY_FOR_PAYOUT: ['PAID_OUT', 'SKIPPED', 'CANCELLED'],
      SKIPPED: ['READY_FOR_PAYOUT', 'CANCELLED'],
      PAID_OUT: [],
      CANCELLED: []
    };

    const allowed = validTransitions[currentStatus];
    return Boolean(allowed && allowed.includes(newStatus));
  }
}

// Instância singleton da política de payouts
const payoutsPolicy = new PayoutsPolicy();

module.exports = payoutsPolicy;