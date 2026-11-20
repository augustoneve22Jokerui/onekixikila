const { USER_ROLES } = require('../../shared/constants/roles');
const { SCHEDULE_STATUSES, OBLIGATION_STATUSES, GROUP_STATUSES } = require('../../shared/constants/statuses');

/**
 * Políticas de autorização, integridade temporal e validação de prazos
 * para o módulo de Calendários de Contribuição e Rodadas de Kixikila.
 */
class SchedulesPolicy {
  /**
   * Avalia se o utilizador atuante detém permissão para gerar ou iniciar o cronograma de rodadas do grupo.
   * Ação reservada ao Líder titular (`PRIMARY_LEADER`) do grupo ou a Administradores da plataforma,
   * exigindo que o grupo se encontre no estado operacional `ACTIVE`.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} group - Dados do grupo
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canGenerateSchedule(actingUser, group) {
    if (!actingUser || !group) {
      return { allowed: false, reason: 'Utilizador ou grupo não identificado.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return { allowed: true };
    }

    if (actingUser.id !== group.leader_id && actingUser.id !== group.creator_id) {
      return {
        allowed: false,
        reason: 'Apenas a liderança do grupo pode gerar ou alterar o cronograma de rodadas.'
      };
    }

    if (group.status !== GROUP_STATUSES.ACTIVE && group.status !== GROUP_STATUSES.FORMATION) {
      return {
        allowed: false,
        reason: `Não é possível gerar cronogramas para um grupo no estado [${group.status}].`
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se uma rodada de calendário pode ser ativada para recolha de quotas.
   *
   * @param {object} actingUser
   * @param {object} group
   * @param {object} scheduleRound
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canActivateRound(actingUser, group, scheduleRound) {
    const genCheck = this.canGenerateSchedule(actingUser, group);
    if (!genCheck.allowed) {
      return genCheck;
    }

    if (scheduleRound.status !== SCHEDULE_STATUSES.SCHEDULED) {
      return {
        allowed: false,
        reason: `Apenas rodadas agendadas (SCHEDULED) podem ser ativadas. Estado atual: [${scheduleRound.status}].`
      };
    }

    if (group.status !== GROUP_STATUSES.ACTIVE) {
      return {
        allowed: false,
        reason: 'O grupo deve estar ativo para que as rodadas de contribuição possam ser abertas.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se determinada rodada de calendário pode ser concluída.
   * Exige que não existam quotas em aberto ou pendentes (todas liquidadas ou justificadas).
   *
   * @param {object} scheduleRound
   * @param {number} pendingObligationsCount
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canCompleteRound(scheduleRound, pendingObligationsCount) {
    if (scheduleRound.status !== SCHEDULE_STATUSES.ACTIVE) {
      return {
        allowed: false,
        reason: `Apenas rodadas em curso (ACTIVE) podem ser concluídas. Estado atual: [${scheduleRound.status}].`
      };
    }

    if (pendingObligationsCount > 0) {
      return {
        allowed: false,
        reason: `A rodada ainda possui ${pendingObligationsCount} quota(s) pendente(s) de liquidação.`
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se uma obrigação financeira individual está em atraso dentro da janela de tolerância (mora leve).
   *
   * @param {object} obligation
   * @param {Date} [currentDate=new Date()]
   * @returns {boolean}
   */
  isObligationLate(obligation, currentDate = new Date()) {
    if (!obligation || obligation.status === OBLIGATION_STATUSES.PAID || obligation.status === OBLIGATION_STATUSES.EXCUSED) {
      return false;
    }

    const current = new Date(currentDate).getTime();
    const due = new Date(obligation.due_date).getTime();
    const grace = new Date(obligation.grace_date).getTime();

    return current > due && current <= grace;
  }

  /**
   * Avalia se uma obrigação ultrapassou a data limite de carência (incumprimento formal - DEFAULTED).
   *
   * @param {object} obligation
   * @param {Date} [currentDate=new Date()]
   * @returns {boolean}
   */
  isObligationDefaulted(obligation, currentDate = new Date()) {
    if (!obligation || obligation.status === OBLIGATION_STATUSES.PAID || obligation.status === OBLIGATION_STATUSES.EXCUSED) {
      return false;
    }

    const current = new Date(currentDate).getTime();
    const grace = new Date(obligation.grace_date).getTime();

    return current > grace;
  }

  /**
   * Avalia se o utilizador pode consultar o cronograma e os compromissos de uma rodada.
   *
   * @param {object} actingUser
   * @param {object} group
   * @param {boolean} isMember
   * @returns {boolean}
   */
  canViewSchedule(actingUser, group, isMember = false) {
    if (!group) {
      return false;
    }

    if (actingUser && actingUser.role === USER_ROLES.ADMIN) {
      return true;
    }

    // Participantes ativos do grupo podem consultar o calendário
    return Boolean(actingUser && isMember);
  }
}

// Instância singleton da política de calendários
const schedulesPolicy = new SchedulesPolicy();

module.exports = schedulesPolicy;