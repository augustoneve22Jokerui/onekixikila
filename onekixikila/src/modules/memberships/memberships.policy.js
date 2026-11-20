const { USER_ROLES } = require('../../shared/constants/roles');
const { MEMBERSHIP_STATUSES, GROUP_STATUSES } = require('../../shared/constants/statuses');

/**
 * Políticas de autorização, integridade de compromissos financeiros e regras de conduta
 * para o módulo de Adesões e Filiações a Grupos de Kixikila da plataforma OneKixikila.
 */
class MembershipsPolicy {
  /**
   * Avalia se o utilizador atuante detém poderes de liderança no grupo para deliberar
   * sobre admissão, suspensão ou atribuição de papéis de membros.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} group - Dados do grupo
   * @param {object|null} actingMembership - Filiação do utilizador atuante no grupo
   * @returns {boolean}
   */
  hasLeadershipAuthority(actingUser, group, actingMembership = null) {
    if (!actingUser || !group) {
      return false;
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return true;
    }

    if (actingUser.id === group.leader_id || actingUser.id === group.creator_id) {
      return true;
    }

    if (actingMembership && actingMembership.status === MEMBERSHIP_STATUSES.ACTIVE) {
      return actingMembership.role === 'VICE_LEADER';
    }

    return false;
  }

  /**
   * Avalia se determinado utilizador pode aprovar ou rejeitar pedidos de adesão pendentes.
   *
   * @param {object} actingUser
   * @param {object} group
   * @param {object|null} actingMembership
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canApproveMembership(actingUser, group, actingMembership = null) {
    if (!this.hasLeadershipAuthority(actingUser, group, actingMembership)) {
      return {
        allowed: false,
        reason: 'A deliberação sobre pedidos de adesão é reservada à liderança do grupo.'
      };
    }

    if (group.status === GROUP_STATUSES.COMPLETED || group.status === GROUP_STATUSES.CANCELLED) {
      return {
        allowed: false,
        reason: `Não é possível aprovar adesões num grupo no estado [${group.status}].`
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se a liderança pode suspender ou aplicar restrições cautelares a um participante.
   * Veda a auto-suspensão ou a suspensão do Líder titular sem destituição formal prévia.
   *
   * @param {object} actingUser
   * @param {object} group
   * @param {object} targetMembership
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canManageRestrictions(actingUser, group, targetMembership) {
    if (!this.hasLeadershipAuthority(actingUser, group)) {
      return {
        allowed: false,
        reason: 'A aplicação de penalizações e restrições exige poderes de liderança ou administração.'
      };
    }

    if (targetMembership.user_id === group.leader_id) {
      return {
        allowed: false,
        reason: 'O Líder titular não pode ser suspenso pelas funções de membro. É necessária a transferência de liderança.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se um membro pode sair voluntariamente de um grupo de Kixikila (Regra de Salvaguarda Financeira).
   * Impõe a barreira inegociável: um membro NÃO PODE abandonar o grupo caso possua quotas
   * em atraso/incumprimento ou se já tiver recebido o bolo da Kixikila e tiver compromissos
   * remanescentes até o encerramento do ciclo.
   *
   * @param {object} actingUser
   * @param {object} group
   * @param {object} targetMembership
   * @param {object} financialCommitments - { pendingObligationsCount, hasReceivedPayout, remainingCycleRounds }
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canLeaveGroup(actingUser, group, targetMembership, financialCommitments = {}) {
    if (!actingUser || !targetMembership) {
      return { allowed: false, reason: 'Utilizador ou filiação não identificados.' };
    }

    const isSelf = actingUser.id === targetMembership.user_id;
    const isAdmin = actingUser.role === USER_ROLES.ADMIN;

    if (!isSelf && !isAdmin) {
      return {
        allowed: false,
        reason: 'Não possui autorização para solicitar o cancelamento de filiação de outro membro.'
      };
    }

    // O Líder titular não pode simplesmente sair do grupo sem transferir a liderança
    if (targetMembership.user_id === group.leader_id && group.status !== GROUP_STATUSES.COMPLETED) {
      return {
        allowed: false,
        reason: 'O Líder titular não pode abandonar o grupo sem nomear e transferir a liderança para um sucessor ativo.'
      };
    }

    // Se o grupo ainda estiver em fase de formação (sem dinheiro em circulação), saída imediata é permitida
    if (group.status === GROUP_STATUSES.FORMATION || group.status === GROUP_STATUSES.DRAFT) {
      return { allowed: true };
    }

    const {
      pendingObligationsCount = 0,
      hasReceivedPayout = false,
      remainingCycleRounds = 0
    } = financialCommitments;

    if (pendingObligationsCount > 0) {
      return {
        allowed: false,
        reason: `Possui ${pendingObligationsCount} quota(s) pendente(s) ou em atraso. Regularize os valores antes de sair.`
      };
    }

    if (hasReceivedPayout && remainingCycleRounds > 0) {
      return {
        allowed: false,
        reason: 'Já foi beneficiado com o recebimento do montante da Kixikila neste ciclo. Deve cumprir com as quotas restantes até a conclusão das rotações.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia a validade de uma transição de estado da filiação.
   *
   * @param {string} currentStatus
   * @param {string} newStatus
   * @returns {boolean}
   */
  isValidStatusTransition(currentStatus, newStatus) {
    const validTransitions = {
      PENDING_APPROVAL: ['ACTIVE', 'LEFT', 'EXPELLED'],
      ACTIVE: ['PAUSED', 'SUSPENDED', 'DEFAULTED', 'LEFT', 'EXPELLED'],
      PAUSED: ['ACTIVE', 'SUSPENDED', 'LEFT'],
      SUSPENDED: ['ACTIVE', 'EXPELLED'],
      DEFAULTED: ['ACTIVE', 'EXPELLED'], // Retorno a ACTIVE apenas após liquidação auditada
      LEFT: [],
      EXPELLED: []
    };

    const allowed = validTransitions[currentStatus];
    return Boolean(allowed && allowed.includes(newStatus));
  }
}

// Instância singleton da política de filiações
const membershipsPolicy = new MembershipsPolicy();

module.exports = membershipsPolicy;