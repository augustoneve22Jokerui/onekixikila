const { USER_ROLES } = require('../../shared/constants/roles');
const { GROUP_STATUSES, USER_STATUSES } = require('../../shared/constants/statuses');
const limitsConfig = require('../../config/limits');

/**
 * Políticas de autorização, controlo de regras e integridade do ciclo de vida
 * dos Grupos de Kixikila na plataforma OneKixikila.
 */
class GroupsPolicy {
  /**
   * Avalia se determinado utilizador detém condições cadastrais para criar um novo grupo de Kixikila.
   * Exige conta ativa, telemóvel verificado e respeito ao limite de grupos simultâneos por nível de KYC.
   *
   * @param {object} user - Utilizador autenticado (req.user)
   * @param {number} activeGroupsCount - Quantidade de grupos atualmente geridos pelo utilizador
   * @param {string} [userTier='TIER_1_UNVERIFIED'] - Nível de verificação KYC do utilizador
   * @returns {{ allowed: boolean, reason?: string }}
   */
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

    if (!user.isPhoneVerified) {
      return {
        allowed: false,
        reason: 'É obrigatório validar o seu número de telemóvel antes de criar um grupo de Kixikila.'
      };
    }

    // Consulta teto de grupos ativos configurado para o nível de KYC
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

  /**
   * Avalia se o utilizador pode visualizar a ficha detalhada de um grupo.
   * Grupos públicos são visíveis a utilizadores ativos; grupos privados são restritos aos seus membros e administradores.
   *
   * @param {object} actingUser
   * @param {object} group
   * @param {boolean} isMember - Se o utilizador possui filiação no grupo
   * @returns {boolean}
   */
  canViewGroup(actingUser, group, isMember = false) {
    if (!group) {
      return false;
    }

    // Administradores gerais podem auditar qualquer grupo
    if (actingUser && actingUser.role === USER_ROLES.ADMIN) {
      return true;
    }

    // Grupos públicos são consultáveis por qualquer utilizador
    if (!group.is_private) {
      return true;
    }

    // Grupos privados exigem filiação confirmada
    return Boolean(actingUser && isMember);
  }

  /**
   * Avalia se o utilizador possui autorização para editar informações cadastrais ou regras do grupo.
   * Restrito ao Líder titular do grupo ou a Administradores da plataforma.
   *
   * @param {object} actingUser
   * @param {object} group
   * @returns {{ allowed: boolean, reason?: string }}
   */
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

  /**
   * Avalia se o regulamento operacional pode ser alterado.
   * Regras críticas (valor de quota, carência, multas) só podem ser editadas enquanto o grupo
   * estiver na fase de formação (`FORMATION` ou `DRAFT`). Após entrar em funcionamento regular (`ACTIVE`),
   * alterações unilaterais são proibidas para proteger a segurança dos fundos.
   *
   * @param {object} actingUser
   * @param {object} group
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canUpdateRules(actingUser, group) {
    const manageCheck = this.canManageGroup(actingUser, group);
    if (!manageCheck.allowed) {
      return manageCheck;
    }

    if (group.status === GROUP_STATUSES.ACTIVE) {
      return {
        allowed: false,
        reason: 'O regulamento de um grupo ativo não pode ser alterado unilateralmente após o início das rotações financeiras.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se um grupo pode ser ativado formalmente para iniciar as rodadas financeiras.
   * Exige estado de formação e preenchimento da quantidade mínima regulamentar de membros.
   *
   * @param {object} group
   * @param {number} activeMembersCount
   * @returns {{ allowed: boolean, reason?: string }}
   */
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

  /**
   * Valida se uma transição de estado no ciclo de vida do grupo é permitida pelas regras de negócio.
   *
   * @param {string} currentStatus
   * @param {string} newStatus
   * @returns {boolean}
   */
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

  /**
   * Avalia se um utilizador pode solicitar adesão ou entrar no grupo de Kixikila.
   *
   * @param {object} user - Utilizador requerente
   * @param {object} group - Dados do grupo
   * @param {number} activeMembersCount
   * @param {boolean} isAlreadyMember
   * @param {string} [userTier='TIER_1_UNVERIFIED']
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canRequestJoin(user, group, activeMembersCount, isAlreadyMember, userTier = 'TIER_1_UNVERIFIED') {
    if (!user) {
      return { allowed: false, reason: 'Autenticação necessária.' };
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

    // Se o grupo exigir verificação de identidade oficial (KYC aprovado)
    if (group.require_identity_verification && userTier === 'TIER_1_UNVERIFIED') {
      return {
        allowed: false,
        reason: 'As regras deste grupo exigem que a sua identidade (Bilhete de Identidade) esteja previamente verificada e aprovada.'
      };
    }

    return { allowed: true };
  }
}

// Instância singleton da política de grupos
const groupsPolicy = new GroupsPolicy();

module.exports = groupsPolicy;