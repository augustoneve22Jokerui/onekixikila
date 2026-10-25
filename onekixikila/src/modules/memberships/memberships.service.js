const membershipsRepository = require('./memberships.repository');
const membershipsPolicy = require('./memberships.policy');
const groupsRepository = require('../groups/groups.repository');
const groupsPolicy = require('../groups/groups.policy');
const { queryOne } = require('../../database/query');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');

/**
 * Serviço de regras de negócio para Adesões, Gestão de Membros e Salvaguardas Financeiras
 * nos Grupos de Kixikila da plataforma OneKixikila.
 */
class MembershipsService {
  /**
   * Processa a solicitação de entrada de um utilizador num grupo de Kixikila.
   * Se o regulamento do grupo dispensar aprovação prévia, ativa a adesão de imediato;
   * caso contrário, coloca o pedido em lista de espera (PENDING_APPROVAL).
   *
   * @param {object} user - Utilizador autenticado (req.user)
   * @param {string} groupId - UUID do grupo
   * @param {object} [context={}]
   * @returns {Promise<object>} Registo da filiação criada
   */
  async requestJoinGroup(user, groupId, context = {}) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    // 1. Verifica se já possui filiação no grupo
    const existingMembership = await membershipsRepository.findByGroupAndUser(groupId, user.id);
    const isAlreadyMember = Boolean(existingMembership && existingMembership.status !== 'LEFT' && existingMembership.status !== 'EXPELLED');

    const activeMembersCount = Number(group.active_members_count) || 0;
    const userTier = user.identity_tier || 'TIER_1_UNVERIFIED';

    const joinCheck = groupsPolicy.canRequestJoin(user, group, activeMembersCount, isAlreadyMember, userTier);
    if (!joinCheck.allowed) {
      throw new ConflictError(joinCheck.reason, 'JOIN_REQUEST_BLOCKED');
    }

    // 2. Avalia exigência regulamentar de aprovação pela liderança
    const requireApproval = group.require_admin_approval_to_join !== false;
    let initialStatus = 'PENDING_APPROVAL';
    let assignedSlot = null;

    if (!requireApproval) {
      initialStatus = 'ACTIVE';
      assignedSlot = await membershipsRepository.getNextAvailableSlot(groupId);
    }

    const membership = await membershipsRepository.createMembership({
      groupId,
      userId: user.id,
      role: 'MEMBER',
      status: initialStatus,
      slotNumber: assignedSlot,
      approvedBy: requireApproval ? null : group.leader_id
    });

    const eventName = requireApproval
      ? EVENT_TYPES.GROUP_MEMBERSHIP_REQUESTED
      : EVENT_TYPES.GROUP_MEMBERSHIP_APPROVED;

    eventBus.publish(eventName, {
      groupId,
      userId: user.id,
      membershipId: membership.id,
      status: initialStatus
    }, { requestId: context.requestId });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'CREATE',
        resourceType: 'GROUP_MEMBERSHIP',
        resourceId: membership.id,
        metadata: {
          groupId,
          status: initialStatus,
          slotNumber: assignedSlot
        }
      });
    }

    return {
      membershipId: membership.id,
      status: initialStatus,
      slotNumber: assignedSlot,
      message: requireApproval
        ? 'Pedido de adesão submetido com sucesso. Aguarda validação pela liderança do grupo.'
        : 'Adesão confirmada com sucesso! Já faz parte deste grupo de Kixikila.'
    };
  }

  /**
   * Aprova formalmente a adesão de um participante pendente e atribui a sua vaga/turno sequencial.
   *
   * @param {object} actingUser
   * @param {string} membershipId
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async approveMembership(actingUser, membershipId, context = {}) {
    const membership = await membershipsRepository.findById(membershipId);
    if (!membership) {
      throw NotFoundError.resource('Pedido de Adesão', membershipId);
    }

    const group = await groupsRepository.findById(membership.group_id);
    if (!group) {
      throw NotFoundError.group(membership.group_id);
    }

    const actingMembership = await membershipsRepository.findByGroupAndUser(group.id, actingUser.id);
    const approvalCheck = membershipsPolicy.canApproveMembership(actingUser, group, actingMembership);
    if (!approvalCheck.allowed) {
      throw new AuthorizationError(approvalCheck.reason);
    }

    if (membership.status !== 'PENDING_APPROVAL') {
      throw new ConflictError(`Esta adesão já foi processada anteriormente. Estado atual: [${membership.status}].`);
    }

    const activeCount = Number(group.active_members_count) || 0;
    if (activeCount >= group.max_members) {
      throw new ConflictError(`O grupo atingiu a capacidade limite de ${group.max_members} participantes.`);
    }

    const nextSlot = await membershipsRepository.getNextAvailableSlot(group.id);

    const updated = await membershipsRepository.updateStatus(membershipId, 'ACTIVE', {
      approvedBy: actingUser.id,
      slotNumber: nextSlot
    });

    eventBus.publish(EVENT_TYPES.GROUP_MEMBERSHIP_APPROVED, {
      groupId: group.id,
      userId: membership.user_id,
      membershipId,
      slotNumber: nextSlot,
      approvedBy: actingUser.id
    }, { requestId: context.requestId });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'GROUP_MEMBERSHIP',
        resourceId: membershipId,
        oldValues: { status: membership.status },
        newValues: { status: 'ACTIVE', slotNumber: nextSlot, approvedBy: actingUser.id }
      });
    }

    return {
      message: 'Membro aprovado com sucesso no grupo de Kixikila.',
      membership: updated
    };
  }

  /**
   * Rejeita o pedido de participação de um utilizador.
   *
   * @param {object} actingUser
   * @param {string} membershipId
   * @param {string} [reason='REJECTED_BY_LEADER']
   * @param {object} [context={}]
   * @returns {Promise<{ message: string }>}
   */
  async rejectMembership(actingUser, membershipId, reason = 'REJECTED_BY_LEADER', context = {}) {
    const membership = await membershipsRepository.findById(membershipId);
    if (!membership) {
      throw NotFoundError.resource('Pedido de Adesão', membershipId);
    }

    const group = await groupsRepository.findById(membership.group_id);
    const actingMembership = await membershipsRepository.findByGroupAndUser(group.id, actingUser.id);

    const approvalCheck = membershipsPolicy.canApproveMembership(actingUser, group, actingMembership);
    if (!approvalCheck.allowed) {
      throw new AuthorizationError(approvalCheck.reason);
    }

    if (membership.status !== 'PENDING_APPROVAL') {
      throw new ConflictError('Apenas pedidos pendentes podem ser rejeitados.');
    }

    await membershipsRepository.deleteMembership(membershipId);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'DELETE',
        resourceType: 'GROUP_MEMBERSHIP',
        resourceId: membershipId,
        metadata: { groupId: group.id, rejectedUserId: membership.user_id, reason }
      });
    }

    return {
      message: 'Pedido de adesão rejeitado pela liderança.'
    };
  }

  /**
   * Aplica ou remove restrições cautelares a um membro (ex: proibição de chat ou bloqueio de quota).
   *
   * @param {object} actingUser
   * @param {string} membershipId
   * @param {object} restrictions
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async updateRestrictions(actingUser, membershipId, restrictions, context = {}) {
    const membership = await membershipsRepository.findById(membershipId);
    if (!membership) {
      throw NotFoundError.resource('Filiação', membershipId);
    }

    const group = await groupsRepository.findById(membership.group_id);
    const check = membershipsPolicy.canManageRestrictions(actingUser, group, membership);
    if (!check.allowed) {
      throw new AuthorizationError(check.reason);
    }

    const updated = await membershipsRepository.updateRestrictions(membershipId, restrictions);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'MEMBERSHIP_RESTRICTIONS',
        resourceId: membershipId,
        newValues: restrictions
      });
    }

    return updated;
  }

  /**
   * Suspende temporariamente a participação de um membro.
   *
   * @param {object} actingUser
   * @param {string} membershipId
   * @param {string} reason
   * @param {Date|null} [suspendedUntil=null]
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async suspendMember(actingUser, membershipId, reason, suspendedUntil = null, context = {}) {
    const membership = await membershipsRepository.findById(membershipId);
    if (!membership) {
      throw NotFoundError.resource('Filiação', membershipId);
    }

    const group = await groupsRepository.findById(membership.group_id);
    const check = membershipsPolicy.canManageRestrictions(actingUser, group, membership);
    if (!check.allowed) {
      throw new AuthorizationError(check.reason);
    }

    const updated = await membershipsRepository.updateStatus(membershipId, 'SUSPENDED', {
      suspensionReason: reason,
      suspendedUntil
    });

    eventBus.publish(EVENT_TYPES.GROUP_MEMBERSHIP_SUSPENDED, {
      groupId: group.id,
      userId: membership.user_id,
      membershipId,
      reason,
      suspendedUntil
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'MEMBERSHIP_SUSPENSION',
        resourceId: membershipId,
        metadata: { reason, suspendedUntil, suspendedBy: actingUser.id }
      });
    }

    return updated;
  }

  /**
   * Reativa um membro suspenso.
   *
   * @param {object} actingUser
   * @param {string} membershipId
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async reactivateMember(actingUser, membershipId, context = {}) {
    const membership = await membershipsRepository.findById(membershipId);
    if (!membership) {
      throw NotFoundError.resource('Filiação', membershipId);
    }

    const group = await groupsRepository.findById(membership.group_id);
    const check = membershipsPolicy.canManageRestrictions(actingUser, group, membership);
    if (!check.allowed) {
      throw new AuthorizationError(check.reason);
    }

    const updated = await membershipsRepository.updateStatus(membershipId, 'ACTIVE');

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'MEMBERSHIP_REACTIVATION',
        resourceId: membershipId,
        metadata: { reactivatedBy: actingUser.id }
      });
    }

    return updated;
  }

  /**
   * Processa a saída voluntária de um membro com verificação estrita de compromissos financeiros.
   *
   * @param {object} actingUser
   * @param {string} membershipId
   * @param {object} [context={}]
   * @returns {Promise<{ message: string }>}
   */
  async leaveGroup(actingUser, membershipId, context = {}) {
    const membership = await membershipsRepository.findById(membershipId);
    if (!membership) {
      throw NotFoundError.resource('Filiação', membershipId);
    }

    const group = await groupsRepository.findById(membership.group_id);

    // 1. Apuração de quotas pendentes ou vencidas
    const obligationsSql = `
      SELECT COUNT(*)::integer AS pending_count
      FROM contribution_obligations
      WHERE membership_id = $1 AND status IN ('PENDING', 'LATE', 'DEFAULTED');
    `;
    const obligationsRes = await queryOne(obligationsSql, [membershipId]);
    const pendingCount = obligationsRes ? obligationsRes.pending_count : 0;

    // 2. Apuração de benefícios já recebidos no ciclo ativo da Kixikila
    const payoutSql = `
      SELECT COUNT(*)::integer AS payout_count
      FROM beneficiary_assignments ba
      INNER JOIN rotation_schedules rs ON rs.id = ba.rotation_id
      WHERE ba.membership_id = $1
        AND rs.status = 'PAID_OUT'
        AND rs.cycle_number = $2;
    `;
    const payoutRes = await queryOne(payoutSql, [membershipId, group.current_cycle]);
    const hasReceivedPayout = payoutRes && payoutRes.payout_count > 0;

    // 3. Rodadas remanescentes a concluir no ciclo
    const remainingRoundsSql = `
      SELECT COUNT(*)::integer AS remaining_count
      FROM contribution_schedules
      WHERE group_id = $1 AND cycle_number = $2 AND status IN ('SCHEDULED', 'ACTIVE');
    `;
    const roundsRes = await queryOne(remainingRoundsSql, [group.id, group.current_cycle]);
    const remainingRounds = roundsRes ? roundsRes.remaining_count : 0;

    const financialCommitments = {
      pendingObligationsCount: pendingCount,
      hasReceivedPayout,
      remainingCycleRounds: remainingRounds
    };

    const leaveCheck = membershipsPolicy.canLeaveGroup(actingUser, group, membership, financialCommitments);
    if (!leaveCheck.allowed) {
      throw new ConflictError(leaveCheck.reason, 'LEAVE_GROUP_BLOCKED');
    }

    await membershipsRepository.updateStatus(membershipId, 'LEFT');

    eventBus.publish(EVENT_TYPES.GROUP_MEMBERSHIP_LEFT, {
      groupId: group.id,
      userId: membership.user_id,
      membershipId
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'MEMBERSHIP_EXIT',
        resourceId: membershipId,
        metadata: { reason: 'VOLUNTARY_EXIT' }
      });
    }

    return {
      message: 'A sua filiação ao grupo foi encerrada com sucesso.'
    };
  }

  /**
   * Consulta a lista de membros de um grupo com dados de perfil e papéis internos.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {object} [filters={}]
   * @returns {Promise<Array<object>>}
   */
  async listGroupMembers(actingUser, groupId, filters = {}) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const membership = await membershipsRepository.findByGroupAndUser(groupId, actingUser ? actingUser.id : null);
    const isMember = Boolean(membership && membership.status === 'ACTIVE');

    if (!groupsPolicy.canViewGroup(actingUser, group, isMember)) {
      throw AuthorizationError.forbiddenResource('Acesso restrito aos membros deste grupo.');
    }

    return membershipsRepository.listMembersByGroup(groupId, filters);
  }

  /**
   * Lista todos os grupos nos quais determinado utilizador participa.
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @param {object} [filters={}]
   * @returns {Promise<Array<object>>}
   */
  async listUserMemberships(actingUser, targetUserId, filters = {}) {
    if (actingUser.id !== targetUserId && actingUser.role !== 'ADMIN') {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado às filiações de outro utilizador.');
    }

    return membershipsRepository.listUserMemberships(targetUserId, filters);
  }
}

// Instância singleton do serviço de filiações
const membershipsService = new MembershipsService();

module.exports = membershipsService;