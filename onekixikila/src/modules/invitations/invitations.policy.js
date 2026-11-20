// =============================================================================
// modules/invitations/invitations.policy.js
// =============================================================================

const { USER_ROLES } = require('../../shared/constants/roles');
const {
  INVITATION_STATUSES,
  GROUP_STATUSES,
  MEMBERSHIP_STATUSES
} = require('../../shared/constants/statuses');

/**
 * Políticas de autorização, integridade de quotas e validação temporal
 * para a emissão, revogação e aceitação de Convites de Grupos de Kixikila.
 */
class InvitationsPolicy {
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
    const isViceLeader =
      actingMembership &&
      actingMembership.role === 'VICE_LEADER' &&
      actingMembership.status === MEMBERSHIP_STATUSES.ACTIVE;

    if (group.is_private && !isLeader && !isViceLeader) {
      return {
        allowed: false,
        reason: 'Neste grupo privado de Kixikila, a emissão de convites é restrita à liderança.'
      };
    }

    if (!isLeader && (!actingMembership || actingMembership.status !== MEMBERSHIP_STATUSES.ACTIVE)) {
      return {
        allowed: false,
        reason: 'Apenas participantes com filiação ativa podem convidar novos membros.'
      };
    }

    return { allowed: true };
  }

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

  isInvitationUsable(invitation) {
    if (!invitation) {
      return { usable: false, reason: 'Convite não localizado ou código inexistente.' };
    }

    if (
      invitation.status === INVITATION_STATUSES.EXPIRED ||
      new Date(invitation.expires_at).getTime() < Date.now()
    ) {
      return { usable: false, reason: 'Este convite de Kixikila expirou.' };
    }

    if (invitation.status === INVITATION_STATUSES.REVOKED) {
      return { usable: false, reason: 'Este convite foi revogado pela liderança do grupo.' };
    }

    if (
      invitation.status === INVITATION_STATUSES.ACCEPTED ||
      invitation.used_count >= invitation.max_uses
    ) {
      return {
        usable: false,
        reason: 'Este convite atingiu o limite máximo de utilizações autorizadas.'
      };
    }

    return { usable: true };
  }

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

    if (invitation.invited_phone && user.phoneNumber !== invitation.invited_phone) {
      return {
        allowed: false,
        reason: 'Este convite foi emitido com exclusividade para outro número de telemóvel.'
      };
    }

    if (
      invitation.invited_email &&
      user.email &&
      user.email.toLowerCase() !== invitation.invited_email.toLowerCase()
    ) {
      return {
        allowed: false,
        reason: 'Este convite foi emitido com exclusividade para outro endereço de e-mail.'
      };
    }

    if (group.require_identity_verification && userTier === 'TIER_1_UNVERIFIED') {
      return {
        allowed: false,
        reason:
          'As regras deste grupo exigem que a sua identidade (Bilhete de Identidade) esteja previamente verificada e aprovada.'
      };
    }

    return { allowed: true };
  }
}

const invitationsPolicy = new InvitationsPolicy();

module.exports = invitationsPolicy;