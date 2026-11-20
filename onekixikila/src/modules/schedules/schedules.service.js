const schedulesRepository = require('./schedules.repository');
const schedulesPolicy = require('./schedules.policy');
const groupsRepository = require('../groups/groups.repository');
const membershipsRepository = require('../memberships/memberships.repository');
const { withTransaction } = require('../../database/transaction');
const {
  calculateNextDueDate,
  calculateGraceEndDate,
  toSqlDateString
} = require('../../shared/utils/dates');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');

/**
 * Serviço de regras de negócio para a geração e gestão de Calendários de Contribuição,
 * datas de vencimento, tolerância e emissão de quotas nos Grupos de Kixikila.
 */
class SchedulesService {
  /**
   * Gera o cronograma completo de rodadas para o ciclo ativo da Kixikila.
   * Calcula as datas de vencimento e tolerância para cada rodada com base na frequência do grupo
   * (DAILY, WEEKLY, BIWEEKLY, MONTHLY) e emite as obrigações iniciais para os participantes.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} groupId - UUID do grupo
   * @param {object} [context={}]
   * @returns {Promise<Array<object>>} Rodadas geradas
   */
  async generateCycleSchedule(actingUser, groupId, context = {}) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const permissionCheck = schedulesPolicy.canGenerateSchedule(actingUser, group);
    if (!permissionCheck.allowed) {
      throw new AuthorizationError(permissionCheck.reason);
    }

    // 1. Obtém os membros ativos do grupo para determinar a quantidade de rodadas
    const activeMembers = await membershipsRepository.listMembersByGroup(groupId, { status: 'ACTIVE' });
    const totalRounds = activeMembers.length;

    if (totalRounds < group.min_members) {
      throw new ConflictError(
        `O grupo possui apenas ${totalRounds} participante(s) ativo(s). São necessários no mínimo ${group.min_members} para gerar o calendário.`
      );
    }

    // 2. Consulta se já existem rodadas geradas para o ciclo atual
    const existingRounds = await schedulesRepository.listSchedulesByGroup(groupId, group.current_cycle);
    if (existingRounds.length > 0) {
      throw new ConflictError(`Já existe um cronograma gerado para o ciclo ${group.current_cycle} deste grupo.`);
    }

    const graceDays = group.grace_period_days !== undefined ? Number(group.grace_period_days) : 2;
    const baseStartDate = group.start_date ? new Date(group.start_date) : new Date();

    // 3. Execução transacional atómica da criação do cronograma e obrigações da 1ª rodada
    const generatedRounds = await withTransaction(async (client) => {
      const createdRounds = [];
      let currentDueDate = baseStartDate;

      for (let roundNumber = 1; roundNumber <= totalRounds; roundNumber++) {
        // Na primeira rodada utiliza a data de início; nas seguintes calcula pela periodicidade
        if (roundNumber > 1) {
          currentDueDate = calculateNextDueDate(currentDueDate, group.frequency);
        }

        const graceEndDate = calculateGraceEndDate(currentDueDate, graceDays);

        const round = await schedulesRepository.createScheduleRound(
          {
            groupId: group.id,
            cycleNumber: group.current_cycle,
            roundNumber,
            dueDate: toSqlDateString(currentDueDate),
            gracePeriodEndDate: toSqlDateString(graceEndDate),
            expectedAmountPerMember: group.contribution_amount,
            currency: group.currency || 'AOA',
            status: roundNumber === 1 ? 'ACTIVE' : 'SCHEDULED'
          },
          client
        );

        createdRounds.push(round);

        // Gera as obrigações individuais exigíveis para a primeira rodada
        if (roundNumber === 1) {
          const obligationsBatch = activeMembers.map((m) => ({
            scheduleId: round.id,
            groupId: group.id,
            userId: m.user_id,
            membershipId: m.membership_id,
            expectedAmount: group.contribution_amount,
            currency: group.currency || 'AOA',
            dueDate: toSqlDateString(currentDueDate),
            graceDate: toSqlDateString(graceEndDate)
          }));

          await schedulesRepository.createObligationsBatch(obligationsBatch, client);
        }
      }

      return createdRounds;
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'CREATE',
        resourceType: 'GROUP_SCHEDULE',
        resourceId: groupId,
        metadata: {
          cycleNumber: group.current_cycle,
          totalRounds,
          frequency: group.frequency
        }
      });
    }

    return generatedRounds;
  }

  /**
   * Ativa formalmente uma rodada de calendário (SCHEDULED -> ACTIVE)
   * e gera em lote as obrigações individuais exigíveis a cada participante ativo.
   *
   * @param {object} actingUser
   * @param {string} scheduleId
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async activateRound(actingUser, scheduleId, context = {}) {
    const round = await schedulesRepository.findScheduleById(scheduleId);
    if (!round) {
      throw NotFoundError.resource('Rodada de Calendário', scheduleId);
    }

    const group = await groupsRepository.findById(round.group_id);
    const activateCheck = schedulesPolicy.canActivateRound(actingUser, group, round);
    if (!activateCheck.allowed) {
      throw new ConflictError(activateCheck.reason, 'ROUND_ACTIVATION_BLOCKED');
    }

    const activeMembers = await membershipsRepository.listMembersByGroup(group.id, { status: 'ACTIVE' });

    const activated = await withTransaction(async (client) => {
      const updatedRound = await schedulesRepository.updateScheduleStatus(scheduleId, 'ACTIVE', client);

      const obligationsBatch = activeMembers.map((m) => ({
        scheduleId: round.id,
        groupId: group.id,
        userId: m.user_id,
        membershipId: m.membership_id,
        expectedAmount: round.expected_amount_per_member,
        currency: round.currency || 'AOA',
        dueDate: round.due_date,
        graceDate: round.grace_period_end_date
      }));

      await schedulesRepository.createObligationsBatch(obligationsBatch, client);

      return updatedRound;
    });

    eventBus.publish(EVENT_TYPES.CONTRIBUTION_DUE_REMINDER, {
      groupId: group.id,
      scheduleId: round.id,
      roundNumber: round.round_number,
      dueDate: round.due_date,
      expectedAmount: round.expected_amount_per_member
    }, { requestId: context.requestId });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'GROUP_SCHEDULE',
        resourceId: scheduleId,
        oldValues: { status: round.status },
        newValues: { status: 'ACTIVE' }
      });
    }

    return activated;
  }

  /**
   * Conclui uma rodada após a verificação de quitação integral das quotas de todos os membros.
   *
   * @param {object} actingUser
   * @param {string} scheduleId
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async completeRound(actingUser, scheduleId, context = {}) {
    const round = await schedulesRepository.findScheduleById(scheduleId);
    if (!round) {
      throw NotFoundError.resource('Rodada de Calendário', scheduleId);
    }

    const group = await groupsRepository.findById(round.group_id);
    const pendingCount = await schedulesRepository.countPendingObligations(scheduleId);

    const completeCheck = schedulesPolicy.canCompleteRound(round, pendingCount);
    if (!completeCheck.allowed) {
      throw new ConflictError(completeCheck.reason, 'ROUND_COMPLETION_BLOCKED');
    }

    const completed = await schedulesRepository.updateScheduleStatus(scheduleId, 'COMPLETED');

    eventBus.publish(EVENT_TYPES.ROTATION_ROUND_COMPLETED, {
      groupId: group.id,
      scheduleId: round.id,
      roundNumber: round.round_number,
      cycleNumber: round.cycle_number
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'GROUP_SCHEDULE',
        resourceId: scheduleId,
        oldValues: { status: round.status },
        newValues: { status: 'COMPLETED' }
      });
    }

    return completed;
  }

  /**
   * Consulta o cronograma de rodadas de um grupo de Kixikila.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {number|null} [cycleNumber=null]
   * @returns {Promise<Array<object>>}
   */
  async getGroupSchedule(actingUser, groupId, cycleNumber = null) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    let isMember = false;
    if (actingUser) {
      const membership = await membershipsRepository.findByGroupAndUser(groupId, actingUser.id);
      isMember = Boolean(membership && membership.status === 'ACTIVE');
    }

    if (!schedulesPolicy.canViewSchedule(actingUser, group, isMember)) {
      throw AuthorizationError.forbiddenResource('Acesso restrito aos participantes deste grupo.');
    }

    return schedulesRepository.listSchedulesByGroup(groupId, cycleNumber);
  }

  /**
   * Consulta os detalhes de uma rodada específica com a lista de quotas exigíveis por membro.
   *
   * @param {object} actingUser
   * @param {string} scheduleId
   * @returns {Promise<object>}
   */
  async getRoundDetails(actingUser, scheduleId) {
    const round = await schedulesRepository.findScheduleById(scheduleId);
    if (!round) {
      throw NotFoundError.resource('Rodada de Calendário', scheduleId);
    }

    const group = await groupsRepository.findById(round.group_id);
    let isMember = false;
    if (actingUser) {
      const membership = await membershipsRepository.findByGroupAndUser(group.id, actingUser.id);
      isMember = Boolean(membership && membership.status === 'ACTIVE');
    }

    if (!schedulesPolicy.canViewSchedule(actingUser, group, isMember)) {
      throw AuthorizationError.forbiddenResource('Acesso restrito aos participantes deste grupo.');
    }

    const obligations = await schedulesRepository.getObligationsBySchedule(scheduleId);

    return {
      round,
      obligations
    };
  }

  /**
   * Consulta as quotas pendentes a vencer do próprio utilizador autenticado em todos os seus grupos.
   *
   * @param {object} user - Utilizador autenticado (req.user)
   * @param {number} [limit=10]
   * @returns {Promise<Array<object>>}
   */
  async getMyUpcomingObligations(user, limit = 10) {
    return schedulesRepository.listUserUpcomingObligations(user.id, limit);
  }
}

// Instância singleton do serviço de calendários
const schedulesService = new SchedulesService();

module.exports = schedulesService;