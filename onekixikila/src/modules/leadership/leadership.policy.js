const { USER_ROLES, LEADERSHIP_ROLES } = require('../../shared/constants/roles');
const { MEMBERSHIP_STATUSES, GROUP_STATUSES } = require('../../shared/constants/statuses');
const limitsConfig = require('../../config/limits');

/**
 * Políticas de autorização, integridade de governança e regras de delegação
 * para o módulo de Liderança de Grupos de Kixikila da plataforma OneKixikila.
 */
class LeadershipPolicy {
  /**
   * Avalia se o utilizador atuante detém poderes para designar novos vice-líderes
   * ou delegar poderes interinos no grupo de Kixikila.
   * Ação reservada ao Líder titular (`PRIMARY_LEADER`) ou a Administradores da plataforma.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} group - Dados do grupo
   * @param {object|null} primaryLeaderAssignment - Mandato titular ativo
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canDelegateLeadership(actingUser, group, primaryLeaderAssignment = null) {
    if (!actingUser || !group) {
      return { allowed: false, reason: 'Utilizador ou grupo não identificado.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return { allowed: true };
    }

    if (actingUser.id !== group.leader_id) {
      return {
        allowed: false,
        reason: 'Apenas o Líder titular pode delegar mandatos ou nomear vice-líderes no grupo.'
      };
    }

    if (group.status === GROUP_STATUSES.COMPLETED || group.status === GROUP_STATUSES.CANCELLED) {
      return {
        allowed: false,
        reason: `Não é permitida a delegação de mandatos num grupo no estado [${group.status}].`
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se determinado membro é elegível para receber delegação de liderança
   * (Vice-Líder ou Líder Interino). O membro deve estar ativo, sem dívidas ou restrições de conduta.
   *
   * @param {object} targetMembership - Filiação do membro indigitado
   * @param {number} currentAdminsCount - Total de lideranças ativas no grupo
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canMemberReceiveLeadership(targetMembership, currentAdminsCount = 1) {
    if (!targetMembership) {
      return { allowed: false, reason: 'O utilizador designado não é membro do grupo.' };
    }

    if (targetMembership.status !== MEMBERSHIP_STATUSES.ACTIVE) {
      return {
        allowed: false,
        reason: `O membro encontra-se no estado [${targetMembership.status}] e não pode assumir funções de liderança.`
      };
    }

    if (targetMembership.is_contribution_restricted || targetMembership.is_banned_from_chat) {
      return {
        allowed: false,
        reason: 'Membros com restrições operacionais cautelares ativas não são elegíveis para liderança.'
      };
    }

    const maxAdmins = limitsConfig.groups.maxAdminsPerGroup || 3;
    if (currentAdminsCount >= maxAdmins) {
      return {
        allowed: false,
        reason: `O grupo já atingiu o teto máximo de ${maxAdmins} líderes e vice-líderes simultâneos.`
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se a liderança delegada pode ser revogada pelo utilizador atuante.
   * O Líder titular pode revogar mandatos delegados aos seus vice-líderes;
   * Administradores da plataforma podem intervir e revogar qualquer designação.
   *
   * @param {object} actingUser
   * @param {object} group
   * @param {object} targetAssignment
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canRevokeDelegation(actingUser, group, targetAssignment) {
    if (!actingUser || !group || !targetAssignment) {
      return { allowed: false, reason: 'Parâmetros incompletos para revogação.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return { allowed: true };
    }

    if (actingUser.id !== group.leader_id) {
      return {
        allowed: false,
        reason: 'Apenas o Líder titular ou um Administrador podem revogar poderes delegados.'
      };
    }

    if (targetAssignment.leadership_role === LEADERSHIP_ROLES.PRIMARY_LEADER) {
      return {
        allowed: false,
        reason: 'O mandato de Líder titular não pode ser revogado por este mecanismo. É necessária a transferência de liderança.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador pode consultar o histórico de governança e mandatos do grupo.
   *
   * @param {object} actingUser
   * @param {object} group
   * @param {boolean} isMember
   * @returns {boolean}
   */
  canViewLeadershipHistory(actingUser, group, isMember = false) {
    if (!group) {
      return false;
    }

    if (actingUser && actingUser.role === USER_ROLES.ADMIN) {
      return true;
    }

    return Boolean(actingUser && isMember);
  }
}

// Instância singleton da política de liderança
const leadershipPolicy = new LeadershipPolicy();

module.exports = leadershipPolicy;