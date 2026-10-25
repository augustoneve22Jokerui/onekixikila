const { USER_ROLES } = require('../../shared/constants/roles');
const { INVITATION_STATUSES, GROUP_STATUSES, MEMBERSHIP_STATUSES } = require('../../shared/constants/statuses');

/**
 * Políticas de autorização, integridade de quotas e validação temporal
 * para a emissão, revogação e aceitação de Convites de Grupos de Kixikila.
 */
class InvitationsPolicy {
  /**
   * Avalia se o utilizador atuante detém permissão para emitir convites para o grupo.
   * Em grupos fechados/privados, a emissão é reservada à liderança (Líder titular ou Vice-Líder)
   * e Administradores; em grupos abertos, participantes ativos podem emitir convites.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} group - Dados do grupo
   * @param {object|null} actingMembership - Filiação do utilizador atuante no grupo
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canCreateInvitation(actingUser, group, actingMembership = null) {
    if (!actingUser || !group) {
      return { allowed: false, reason: 'Utilizador ou grupo não identificado.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return { allowed: true };
    }

    if (group.status === GROUP_STATUSES.COMPLETED || group.status === GROUP_STATUSES.CANCELLED) {
      return {
        allowed: false,
        reason: `Não é possível emitir convites para um grupo no estado terminal [${group.status}].`
      };
    }

    const isLeader = actingUser.id === group.leader_id || actingUser.id === group.creator_id;
    const isViceLeader = actingMembership && actingMembership.role === 'VICE_LEADER' && actingMembership.status === MEMBERSHIP_STATUSES.ACTIVE;

    // Em grupos privados, apenas a liderança pode convidar
    if (group.is_private && !isLeader && !isViceLeader) {
      return {
        allowed: false,
        reason: 'Neste grupo privado de Kixikila, a emissão de convites é restrita à liderança.'
      };
    }

    // O utilizador deve ser membro ativo do grupo
    if (!isLeader && (!actingMembership || actingMembership.status !== MEMBERSHIP_STATUSES.ACTIVE)) {
      return {
        allowed: false,
        reason: 'Apenas participantes com filiação ativa podem convidar novos membros.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se a liderança ou o emissor original podem revogar determinado convite pendente.
   *
   * @param {object} actingUser
   * @param {object} invitation - Registo do convite
   * @param {object} group - Dados do grupo
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canRevokeInvitation(actingUser, invitation, group) {
    if (!actingUser || !invitation || !group) {
      return { allowed: false, reason: 'Parâmetros incompletos para revogação.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return { allowed: true };
    }

    const isInviter = actingUser.id === invitation.invited_by;
    const isLeader = actingUser.id === group.leader_id;

    if (!isInviter && !isLeader) {
      return {
        allowed: false,
        reason: 'Apenas o autor do convite ou o Líder titular podem revogar este convite.'
      };
    }

    if (invitation.status !== INVITATION_STATUSES.PENDING) {
      return {
        allowed: false,
        reason: `Este convite encontra-se no estado [${invitation.status}] e não pode ser revogado.`
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se um convite ainda é elegível para utilização (vigência, saldo de usos e estado).
   *
   * @param {object} invitation
   * @returns {{ usable: boolean, reason?: string }}
   */
  isInvitationUsable(invitation) {
    if (!invitation) {
      return { usable: false, reason: 'Convite não localizado ou código inexistente.' };
    }

    if (invitation.status === INVITATION_STATUSES.EXPIRED || new Date(invitation.expires_at).getTime() < Date.now()) {
      return { usable: false, reason: 'Este convite de Kixikila expirou.' };
    }

    if (invitation.status === INVITATION_STATUSES.REVOKED) {
      return { usable: false, reason: 'Este convite foi revogado pela liderança do grupo.' };
    }

    if (invitation.status === INVITATION_STATUSES.ACCEPTED || invitation.used_count >= invitation.max_uses) {
      return { usable: false, reason: 'Este convite atingiu o limite máximo de utilizações autorizadas.' };
    }

    return { usable: true };
  }

  /**
   * Avalia se determinado utilizador atende aos requisitos para aceitar o convite
   * e ser incorporado ao grupo de Kixikila.
   *
   * @param {object} user - Utilizador requerente
   * @param {object} invitation - Dados do convite
   * @param {object} group - Ficha e regras do grupo
   * @param {number} activeMembersCount - Quantidade atual de membros ativos
   * @param {boolean} isAlreadyMember - Se já possui filiação
   * @param {string} [userTier='TIER_1_UNVERIFIED']
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canAcceptInvitation(user, invitation, group, activeMembersCount, isAlreadyMember, userTier = 'TIER_1_UNVERIFIED') {
    if (!user) {
      return { allowed: false, reason: 'Autenticação necessária para aceitar convites.' };
    }

    const usableCheck = this.isInvitationUsable(invitation);
    if (!usableCheck.usable) {
      return { allowed: false, reason: usableCheck.reason };
    }

    if (isAlreadyMember) {
      return { allowed: false, reason: 'Já possui filiação confirmada neste grupo de Kixikila.' };
    }

    if (group.status === GROUP_STATUSES.COMPLETED || group.status === GROUP_STATUSES.CANCELLED) {
      return {
        allowed: false,
        reason: `O grupo encontra-se no estado [${group.status}] e não aceita novos participantes.`
      };
    }

    if (activeMembersCount >= group.max_members) {
      return {
        allowed: false,
        reason: `O grupo já atingiu a sua capacidade máxima de ${group.max_members} participantes.`
      };
    }

    // Se o convite for nominal a um destinatário específico por telemóvel
    if (invitation.invited_phone && user.phoneNumber !== invitation.invited_phone) {
      return {
        allowed: false,
        reason: 'Este convite foi emitido com exclusividade para outro número de telemóvel.'
      };
    }

    // Se o convite for nominal a um endereço de e-mail específico
    if (invitation.invited_email && user.email.toLowerCase() !== invitation.invited_email.toLowerCase()) {
      return {
        allowed: false,
        reason: 'Este convite foi emitido com exclusividade para outro endereço de e-mail.'
      };
    }

    // Se o regulamento do grupo exigir verificação oficial de identidade (KYC aprovado)
    if (group.require_identity_verification && userTier === 'TIER_1_UNVERIFIED') {
      return {
        allowed: false,
        reason: 'As regras deste grupo exigem que a sua identidade (Bilhete de Identidade) esteja previamente verificada e aprovada.'
      };
    }

    return { allowed: true };
  }
}

// Instância singleton da política de convites
const invitationsPolicy = new InvitationsPolicy();

module.exports = invitationsPolicy;