const leadershipRepository = require('./leadership.repository');
const leadershipPolicy = require('./leadership.policy');
const groupsRepository = require('../groups/groups.repository');
const membershipsRepository = require('../memberships/memberships.repository');
const { withTransaction } = require('../../database/transaction');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');

/**
 * Serviço de regras de negócio para Gestão de Mandatos, Delegação de Poderes
 * e Governança de Liderança nos Grupos de Kixikila da plataforma OneKixikila.
 */
class LeadershipService {
  /**
   * Delega mandato e poderes de liderança (ex: Vice-Líder ou Líder Interino) a um membro ativo do grupo.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} groupId - UUID do grupo
   * @param {object} delegationData - { targetUserId, leadershipRole, delegatedUntil, powers }
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async delegateLeadership(actingUser, groupId, delegationData, context = {}) {
    const {
      targetUserId,
      leadershipRole = 'VICE_LEADER',
      delegatedUntil = null,
      powers = { can_approve_members: true, can_manage_schedule: true, can_moderate_chat: true }
    } = delegationData;

    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    // 1. Valida se o utilizador atuante detém poderes para delegar liderança
    const delegationCheck = leadershipPolicy.canDelegateLeadership(actingUser, group);
    if (!delegationCheck.allowed) {
      throw new AuthorizationError(delegationCheck.reason);
    }

    // 2. Valida a filiação do membro indigitado
    const targetMembership = await membershipsRepository.findByGroupAndUser(groupId, targetUserId);
    if (!targetMembership) {
      throw new ConflictError('O utilizador designado para a liderança deve ser um membro ativo do grupo.');
    }

    // 3. Apura a contagem de líderes já ativos para imposição do limite máximo
    const activeLeaders = await leadershipRepository.findActiveLeadership(groupId);
    const eligibilityCheck = leadershipPolicy.canMemberReceiveLeadership(targetMembership, activeLeaders.length);
    if (!eligibilityCheck.allowed) {
      throw new ConflictError(eligibilityCheck.reason, 'LEADERSHIP_DELEGATION_BLOCKED');
    }

    // 4. Executa a delegação atómica no banco de dados
    const assignment = await withTransaction(async (client) => {
      const createdAssignment = await leadershipRepository.createAssignment(
        {
          groupId,
          userId: targetUserId,
          leadershipRole,
          status: 'ACTIVE',
          assignedBy: actingUser.id,
          delegatedUntil: delegatedUntil ? new Date(delegatedUntil) : null,
          powers
        },
        client
      );

      // Promove o papel interno do membro no grupo para VICE_LEADER
      await membershipsRepository.updateRole(targetMembership.id, 'VICE_LEADER', client);

      return createdAssignment;
    });

    eventBus.publish(EVENT_TYPES.GROUP_LEADERSHIP_DELEGATED, {
      groupId,
      targetUserId,
      assignedBy: actingUser.id,
      leadershipRole,
      delegatedUntil
    }, { requestId: context.requestId });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'CREATE',
        resourceType: 'LEADERSHIP_ASSIGNMENT',
        resourceId: assignment.id,
        metadata: {
          groupId,
          targetUserId,
          leadershipRole,
          delegatedUntil
        }
      });
    }

    return {
      message: 'Mandato de liderança delegado com sucesso.',
      assignment
    };
  }

  /**
   * Revoga formalmente uma delegação de liderança (ex: destituição de vice-líder).
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {string} assignmentId
   * @param {string} [reason='DELEGATION_REVOKED']
   * @param {object} [context={}]
   * @returns {Promise<{ message: string }>}
   */
  async revokeDelegation(actingUser, groupId, assignmentId, reason = 'DELEGATION_REVOKED', context = {}) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const assignment = await leadershipRepository.findById(assignmentId);
    if (!assignment) {
      throw NotFoundError.resource('Designação de Liderança', assignmentId);
    }

    const revokeCheck = leadershipPolicy.canRevokeDelegation(actingUser, group, assignment);
    if (!revokeCheck.allowed) {
      throw new AuthorizationError(revokeCheck.reason);
    }

    await withTransaction(async (client) => {
      await leadershipRepository.revokeAssignment(assignmentId, {
        revokedBy: actingUser.id,
        reason
      }, client);

      // Retorna o papel do participante para MEMBER regular
      const targetMembership = await membershipsRepository.findByGroupAndUser(groupId, assignment.user_id, client);
      if (targetMembership) {
        await membershipsRepository.updateRole(targetMembership.id, 'MEMBER', client);
      }
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'DELETE',
        resourceType: 'LEADERSHIP_ASSIGNMENT',
        resourceId: assignmentId,
        metadata: {
          groupId,
          revokedUserId: assignment.user_id,
          reason,
          revokedBy: actingUser.id
        }
      });
    }

    return {
      message: 'Poderes de liderança revogados com sucesso.'
    };
  }

  /**
   * Atualiza a matriz de poderes específicos de uma liderança ativa.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {string} assignmentId
   * @param {object} powers
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async updatePowers(actingUser, groupId, assignmentId, powers, context = {}) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const delegationCheck = leadershipPolicy.canDelegateLeadership(actingUser, group);
    if (!delegationCheck.allowed) {
      throw new AuthorizationError(delegationCheck.reason);
    }

    const assignment = await leadershipRepository.findById(assignmentId);
    if (!assignment) {
      throw NotFoundError.resource('Designação de Liderança', assignmentId);
    }

    const updated = await leadershipRepository.updatePowers(assignmentId, powers);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'LEADERSHIP_POWERS',
        resourceId: assignmentId,
        newValues: powers
      });
    }

    return updated;
  }

  /**
   * Consulta a composição de liderança ativa de determinado grupo de Kixikila.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @returns {Promise<Array<object>>}
   */
  async getActiveLeadership(actingUser, groupId) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    return leadershipRepository.findActiveLeadership(groupId);
  }

  /**
   * Consulta o histórico institucional de mandatos e revogações do grupo para auditoria.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @returns {Promise<Array<object>>}
   */
  async getLeadershipHistory(actingUser, groupId) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const membership = await membershipsRepository.findByGroupAndUser(groupId, actingUser ? actingUser.id : null);
    const isMember = Boolean(membership && membership.status === 'ACTIVE');

    if (!leadershipPolicy.canViewLeadershipHistory(actingUser, group, isMember)) {
      throw AuthorizationError.forbiddenResource('Acesso restrito aos membros deste grupo.');
    }

    return leadershipRepository.listLeadershipHistory(groupId);
  }
}

// Instância singleton do serviço de liderança
const leadershipService = new LeadershipService();

module.exports = leadershipService;