const rotationsRepository = require('./rotations.repository');
const rotationsPolicy = require('./rotations.policy');
const groupsRepository = require('../groups/groups.repository');
const membershipsRepository = require('../memberships/memberships.repository');
const schedulesRepository = require('../schedules/schedules.repository');
const cryptoUtils = require('../../shared/utils/crypto');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const { withTransaction } = require('../../database/transaction');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço de regras de negócio para Rotações, Turnos de Recebimento
 * e Gestão de Beneficiários nos Grupos de Kixikila da plataforma OneKixikila.
 */
class RotationsService {
  /**
   * Gera o plano formal de rotações para o ciclo ativo da Kixikila.
   * Suporta ordenação fixa (FIXED), sorteio transparente criptográfico (RANDOM_DRAW)
   * ou consenso/leilão, alinhando as posições às rodadas de calendário correspondentes.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} groupId - UUID do grupo
   * @param {object} [planOptions={}] - { rotationType }
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async generateRotationPlan(actingUser, groupId, planOptions = {}, context = {}) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const permissionCheck = rotationsPolicy.canManageRotations(actingUser, group);
    if (!permissionCheck.allowed) {
      throw new AuthorizationError(permissionCheck.reason);
    }

    // 1. Obtém os participantes ativos do grupo
    const activeMembers = await membershipsRepository.listMembersByGroup(groupId, { status: 'ACTIVE' });
    const totalMembers = activeMembers.length;

    if (totalMembers < group.min_members) {
      throw new ConflictError(
        `O grupo possui apenas ${totalMembers} participante(s). São necessários no mínimo ${group.min_members} membros ativos para gerar as rotações.`
      );
    }

    // 2. Verifica se já existem rotações cadastradas para o ciclo atual
    const existingRotations = await rotationsRepository.listRotationsByGroup(groupId, group.current_cycle);
    if (existingRotations.length > 0) {
      throw new ConflictError(`Já existe um plano de rotações definido para o ciclo ${group.current_cycle} deste grupo.`);
    }

    // 3. Define a ordem dos beneficiários
    const rotationType = planOptions.rotationType || group.rotation_type || 'FIXED';
    let orderedMembers = [...activeMembers];

    if (rotationType === 'RANDOM_DRAW') {
      // Algoritmo de Fisher-Yates utilizando aleatoriedade criptográfica segura
      for (let i = orderedMembers.length - 1; i > 0; i--) {
        const j = cryptoUtils.randomInt(0, i);
        [orderedMembers[i], orderedMembers[j]] = [orderedMembers[j], orderedMembers[i]];
      }
    } else {
      // Ordenação baseada no slot sequencial de filiação
      orderedMembers.sort((a, b) => (Number(a.slot_number) || 999) - (Number(b.slot_number) || 999));
    }

    // 4. Obtém as rodadas do cronograma de calendário para sincronizar datas estimadas
    const scheduleRounds = await schedulesRepository.listSchedulesByGroup(groupId, group.current_cycle);
    const targetPoolAmount = BigInt(group.contribution_amount) * BigInt(totalMembers);

    // 5. Execução transacional atômica da gravação das rotações e atribuição de beneficiários
    const createdRotations = await withTransaction(async (client) => {
      const results = [];

      for (let position = 1; position <= totalMembers; position++) {
        const member = orderedMembers[position - 1];
        const correspondingSchedule = scheduleRounds.find((s) => s.round_number === position);

        // Se houver rodada correspondente, herda a data de vencimento como estimativa de recebimento
        const estimatedPayoutDate = correspondingSchedule
          ? correspondingSchedule.due_date
          : new Date(Date.now() + position * 30 * 24 * 60 * 60 * 1000);

        const scheduleId = correspondingSchedule ? correspondingSchedule.id : null;

        const rotation = await rotationsRepository.createRotationSchedule(
          {
            groupId: group.id,
            cycleNumber: group.current_cycle,
            positionOrder: position,
            estimatedPayoutDate,
            poolTargetAmount: Number(targetPoolAmount),
            currency: group.currency || 'AOA',
            status: 'PENDING',
            scheduleId
          },
          client
        );

        const assignment = await rotationsRepository.createBeneficiaryAssignment(
          {
            rotationId: rotation.id,
            groupId: group.id,
            beneficiaryUserId: member.user_id,
            membershipId: member.membership_id,
            assignmentType: 'ORIGINAL_ORDER',
            assignedBy: actingUser.id,
            approvedByLeader: true,
            leaderApprovedAt: new Date()
          },
          client
        );

        results.push({
          ...rotation,
          assignment
        });
      }

      return results;
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'CREATE',
        resourceType: 'ROTATION_PLAN',
        resourceId: groupId,
        metadata: {
          cycleNumber: group.current_cycle,
          rotationType,
          totalTurns: totalMembers,
          poolTargetAmount: Number(targetPoolAmount)
        }
      });
    }

    return {
      message: `Plano de rotações com ${totalMembers} turnos gerado com sucesso (${rotationType}).`,
      rotations: createdRotations
    };
  }

  /**
   * Consulta a ordem completa de turnos e beneficiários de um grupo em determinado ciclo.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {number|null} [cycleNumber=null]
   * @returns {Promise<Array<object>>}
   */
  async getGroupRotations(actingUser, groupId, cycleNumber = null) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const membership = await membershipsRepository.findByGroupAndUser(groupId, actingUser ? actingUser.id : null);
    const isMember = Boolean(membership && membership.status === 'ACTIVE');

    if (!rotationsPolicy.canViewRotations(actingUser, group, isMember)) {
      throw AuthorizationError.forbiddenResource('Acesso restrito aos participantes deste grupo.');
    }

    const targetCycle = cycleNumber || group.current_cycle;
    return rotationsRepository.listRotationsByGroup(groupId, targetCycle);
  }

  /**
   * Solicita formalmente uma troca amigável de turno (Swap) entre dois participantes.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {object} swapData - { targetUserId, reason }
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async requestTurnSwap(actingUser, groupId, swapData, context = {}) {
    const { targetUserId, reason = 'Troca consensual de data de recebimento' } = swapData;

    if (!targetUserId) {
      throw ValidationError.fieldRequired('targetUserId');
    }

    if (actingUser.id === targetUserId) {
      throw new ConflictError('Não é possível solicitar troca de turno com a sua própria conta.');
    }

    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    // Localiza os turnos ativos de ambos os membros no ciclo corrente
    const requesterTurn = await rotationsRepository.findActiveTurnByUser(groupId, group.current_cycle, actingUser.id);
    if (!requesterTurn) {
      throw new ConflictError('O utilizador solicitante não possui um turno de recebimento atribuído neste ciclo.');
    }

    const targetTurn = await rotationsRepository.findActiveTurnByUser(groupId, group.current_cycle, targetUserId);
    if (!targetTurn) {
      throw new ConflictError('O participante de destino não possui um turno de recebimento atribuído neste ciclo.');
    }

    const swapCheck = rotationsPolicy.canRequestTurnSwap(actingUser, requesterTurn, targetTurn);
    if (!swapCheck.allowed) {
      throw new ConflictError(swapCheck.reason, 'SWAP_REQUEST_BLOCKED');
    }

    const updatedAssignment = await rotationsRepository.updateAssignmentToSwapRequested({
      assignmentId: requesterTurn.assignment_id,
      swappedWithUserId: targetUserId,
      swapReason: reason
    });

    eventBus.publish(EVENT_TYPES.ROTATION_SWAP_REQUESTED, {
      groupId,
      requesterUserId: actingUser.id,
      targetUserId,
      requesterPosition: requesterTurn.position_order,
      targetPosition: targetTurn.position_order,
      reason
    }, { requestId: context.requestId });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'ROTATION_SWAP',
        resourceId: requesterTurn.assignment_id,
        metadata: {
          groupId,
          targetUserId,
          reason
        }
      });
    }

    return {
      message: 'Solicitação de troca de turno enviada para homologação.',
      swapDetails: {
        requesterTurnPosition: requesterTurn.position_order,
        targetTurnPosition: targetTurn.position_order,
        assignment: updatedAssignment
      }
    };
  }

  /**
   * Homologa formalmente uma permuta de turno entre dois membros (Líder titular ou Administração).
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {string} assignmentId
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async approveTurnSwap(actingUser, groupId, assignmentId, context = {}) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const authCheck = rotationsPolicy.canApproveTurnSwap(actingUser, group);
    if (!authCheck.allowed) {
      throw new AuthorizationError(authCheck.reason);
    }

    const requesterAssignment = await rotationsRepository.findAssignmentById(assignmentId);
    if (!requesterAssignment || requesterAssignment.assignment_type !== 'SWAP_REQUESTED') {
      throw new ConflictError('Nenhuma solicitação de troca pendente localizada para esta designação.');
    }

    const targetTurn = await rotationsRepository.findActiveTurnByUser(
      groupId,
      group.current_cycle,
      requesterAssignment.swapped_with_user_id
    );

    if (!targetTurn) {
      throw new ConflictError('A contraparte da permuta já não detém um turno ativo no ciclo.');
    }

    // Execução atômica da inversão de beneficiários entre as rotações
    const result = await withTransaction(async (client) => {
      // Troca os beneficiários e memberships entre os dois registros de rotação
      await rotationsRepository.swapBeneficiariesBetweenRotations(
        {
          firstRotationId: requesterAssignment.rotation_id,
          secondRotationId: targetTurn.rotation_id,
          firstUserId: requesterAssignment.beneficiary_user_id,
          secondUserId: targetTurn.beneficiary_user_id,
          firstMembershipId: requesterAssignment.membership_id,
          secondMembershipId: targetTurn.membership_id,
          approvedByUserId: actingUser.id
        },
        client
      );

      return {
        firstUserNewPosition: targetTurn.position_order,
        secondUserNewPosition: requesterAssignment.position_order
      };
    });

    eventBus.publish(EVENT_TYPES.ROTATION_SWAP_APPROVED, {
      groupId,
      assignmentId,
      approvedBy: actingUser.id
    }, { requestId: context.requestId });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'ROTATION_SWAP_APPROVED',
        resourceId: assignmentId,
        metadata: {
          groupId,
          approvedBy: actingUser.id
        }
      });
    }

    return {
      message: 'Troca de turno homologada com sucesso pela liderança.',
      updatedAssignments: result
    };
  }

  /**
   * Rejeita ou cancela uma solicitação de permuta de turno.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {string} assignmentId
   * @param {string} reason
   * @param {object} [context={}]
   * @returns {Promise<{ message: string }>}
   */
  async rejectTurnSwap(actingUser, groupId, assignmentId, reason, context = {}) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const assignment = await rotationsRepository.findAssignmentById(assignmentId);
    if (!assignment) {
      throw NotFoundError.resource('Designação de Turno', assignmentId);
    }

    await rotationsRepository.resetAssignmentToOriginal(assignmentId);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'ROTATION_SWAP_REJECTED',
        resourceId: assignmentId,
        metadata: { groupId, reason, rejectedBy: actingUser.id }
      });
    }

    return {
      message: 'Solicitação de troca de turno rejeitada.'
    };
  }

  /**
   * Reatribui emergencialmente um turno de recebimento (Ação discricionária de governança da liderança).
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {string} rotationId
   * @param {object} overrideData - { newBeneficiaryUserId, reason }
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async emergencyOverrideTurn(actingUser, groupId, rotationId, overrideData, context = {}) {
    const { newBeneficiaryUserId, reason } = overrideData;

    if (!newBeneficiaryUserId || !reason) {
      throw ValidationError.fieldRequired('newBeneficiaryUserId e reason');
    }

    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const authCheck = rotationsPolicy.canEmergencyOverride(actingUser, group);
    if (!authCheck.allowed) {
      throw new AuthorizationError(authCheck.reason);
    }

    const targetMembership = await membershipsRepository.findByGroupAndUser(groupId, newBeneficiaryUserId);
    if (!targetMembership || targetMembership.status !== 'ACTIVE') {
      throw new ConflictError('O novo beneficiário deve ser um membro ativo do grupo.');
    }

    const updated = await rotationsRepository.overrideBeneficiaryAssignment({
      rotationId,
      newBeneficiaryUserId,
      newMembershipId: targetMembership.id,
      assignedBy: actingUser.id,
      reason
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'ROTATION_EMERGENCY_OVERRIDE',
        resourceId: rotationId,
        metadata: {
          groupId,
          newBeneficiaryUserId,
          reason,
          overrideBy: actingUser.id
        }
      });
    }

    return {
      message: 'Turno reatribuído emergencialmente com sucesso.',
      assignment: updated
    };
  }

  /**
   * Consulta os turnos atribuídos ao próprio utilizador autenticado em todos os seus grupos.
   *
   * @param {object} user - Utilizador autenticado (req.user)
   * @returns {Promise<Array<object>>}
   */
  async getMyUpcomingTurns(user) {
    return rotationsRepository.listUserUpcomingTurns(user.id);
  }
}

// Instância singleton do serviço de rotações
const rotationsService = new RotationsService();

module.exports = rotationsService;