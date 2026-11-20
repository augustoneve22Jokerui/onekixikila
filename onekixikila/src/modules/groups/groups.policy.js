// =============================================================================
// modules/groups/groups.policy.js
// =============================================================================

const { USER_ROLES } = require('../../shared/constants/roles');
const { GROUP_STATUSES, USER_STATUSES } = require('../../shared/constants/statuses');
const limitsConfig = require('../../config/limits');

/**
 * Políticas de autorização, controlo de regras e integridade do ciclo de vida
 * dos Grupos de Kixikila na plataforma OneKixikila.
 */
class GroupsPolicy {
  canCreateGroup(user, activeGroupsCount = 0, userTier = 'TIER_1_UNVERIFIED') {
    if (!user) {
      return { allowed: false, reason: 'Autenticação necessária para criar um grupo.' };
    }

    if (user.status === USER_STATUSES.BLOCKED || user.status === USER_STATUSES.SUSPENDED) {
      return {
        allowed: false,
        reason: `A sua conta encontra-se no estado [${user.status}]. Criação de grupos não autorizada.`
      };
    }

    const isNonProductionEnv =
      process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

    if (isNonProductionEnv) {
      return { allowed: true };
    }

    if (!user.isPhoneVerified) {
      return {
        allowed: false,
        reason: 'É obrigatório validar o seu número de telemóvel antes de criar um grupo de Kixikila.'
      };
    }

    const tierLimits =
      limitsConfig.financial.tiers[userTier] || limitsConfig.financial.tiers.TIER_1_UNVERIFIED;
    const maxAllowedGroups = tierLimits.maxActiveGroups || 2;

    if (activeGroupsCount >= maxAllowedGroups) {
      return {
        allowed: false,
        reason: `Atingiu o limite de ${maxAllowedGroups} grupo(s) ativo(s) para o seu nível cadastral (${userTier}). Valide a sua identidade (KYC) para aumentar o limite.`
      };
    }

    return { allowed: true };
  }

  canViewGroup(actingUser, group, isMember = false) {
    if (!group) {
      return false;
    }

    if (actingUser && actingUser.role === USER_ROLES.ADMIN) {
      return true;
    }

    if (!group.is_private) {
      return true;
    }

    return Boolean(actingUser && isMember);
  }

  canManageGroup(actingUser, group) {
    if (!actingUser || !group) {
      return { allowed: false, reason: 'Utilizador ou grupo não identificado.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return { allowed: true };
    }

    if (actingUser.id !== group.leader_id && actingUser.id !== group.creator_id) {
      return {
        allowed: false,
        reason: 'Apenas o Líder titular ou o criador possuem permissão para gerir as configurações deste grupo.'
      };
    }

    if (group.status === GROUP_STATUSES.COMPLETED || group.status === GROUP_STATUSES.CANCELLED) {
      return {
        allowed: false,
        reason: `Este grupo encontra-se no estado terminal [${group.status}] e não pode sofrer alterações.`
      };
    }

    return { allowed: true };
  }

  canUpdateRules(actingUser, group) {
    const manageCheck = this.canManageGroup(actingUser, group);
    if (!manageCheck.allowed) {
      return manageCheck;
    }

    if (group.status === GROUP_STATUSES.ACTIVE) {
      return {
        allowed: false,
        reason:
          'O regulamento de um grupo ativo não pode ser alterado unilateralmente após o início das rotações financeiras.'
      };
    }

    return { allowed: true };
  }

  canActivateGroup(group, activeMembersCount) {
    if (group.status !== GROUP_STATUSES.FORMATION) {
      return {
        allowed: false,
        reason: `Apenas grupos no estado de formação (FORMATION) podem ser ativados. Estado atual: [${group.status}].`
      };
    }

    if (activeMembersCount < group.min_members) {
      return {
        allowed: false,
        reason: `O grupo possui ${activeMembersCount} membro(s) ativo(s). São necessários pelo menos ${group.min_members} participantes para iniciar a Kixikila.`
      };
    }

    return { allowed: true };
  }

  isValidStatusTransition(currentStatus, newStatus) {
    const validTransitions = {
      DRAFT: ['FORMATION', 'CANCELLED'],
      FORMATION: ['ACTIVE', 'CANCELLED'],
      ACTIVE: ['PAUSED', 'COMPLETED', 'SUSPENDED'],
      PAUSED: ['ACTIVE', 'SUSPENDED', 'CANCELLED'],
      SUSPENDED: ['ACTIVE', 'CANCELLED'],
      COMPLETED: [],
      CANCELLED: []
    };

    const allowed = validTransitions[currentStatus];
    return Boolean(allowed && allowed.includes(newStatus));
  }

  canRequestJoin(user, group, activeMembersCount, isAlreadyMember, userTier = 'TIER_1_UNVERIFIED') {
    if (!user) {
      return { allowed: false, reason: 'Autenticação necessária.' };
    }

    if (!group) {
      return { allowed: false, reason: 'Grupo não identificado.' };
    }

    // Grupos privados são apenas acessíveis por convite. A aceitação de convites
    // continua a ser tratada pelo fluxo próprio do módulo de convites.
    if (group.is_private) {
      return {
        allowed: false,
        reason: 'Este grupo é privado e só aceita novas adesões através de convite.'
      };
    }

    if (user.status !== USER_STATUSES.ACTIVE && user.status !== USER_STATUSES.PENDING_VERIFICATION) {
      return { allowed: false, reason: 'A sua conta encontra-se restrita para adesão a grupos.' };
    }

    if (isAlreadyMember) {
      return { allowed: false, reason: 'Já possui vínculo de filiação com este grupo de Kixikila.' };
    }

    if (group.status !== GROUP_STATUSES.FORMATION && group.status !== GROUP_STATUSES.ACTIVE) {
      return {
        allowed: false,
        reason: `O grupo encontra-se no estado [${group.status}] e não aceita novas adesões.`
      };
    }

    if (activeMembersCount >= group.max_members) {
      return {
        allowed: false,
        reason: `Este grupo atingiu a capacidade máxima de ${group.max_members} participantes.`
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

const groupsPolicy = new GroupsPolicy();

module.exports = groupsPolicy;
