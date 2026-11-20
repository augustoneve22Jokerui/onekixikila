const { USER_ROLES } = require('../../shared/constants/roles');
const { ROTATION_STATUSES, GROUP_STATUSES } = require('../../shared/constants/statuses');

/**
 * Políticas de autorização, integridade de turnos e governança de rotação
 * para o módulo de Rotações de Kixikila da plataforma OneKixikila.
 */
class RotationsPolicy {
  /**
   * Avalia se o utilizador atuante detém poderes de governança para gerar ou reordenar
   * o plano de rotações do ciclo no grupo de Kixikila.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} group - Dados cadastrais do grupo
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canManageRotations(actingUser, group) {
    if (!actingUser || !group) {
      return { allowed: false, reason: 'Utilizador ou grupo não identificado.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return { allowed: true };
    }

    if (actingUser.id !== group.leader_id && actingUser.id !== group.creator_id) {
      return {
        allowed: false,
        reason: 'Apenas a liderança do grupo ou a administração podem definir o plano de rotações.'
      };
    }

    if (group.status === GROUP_STATUSES.COMPLETED || group.status === GROUP_STATUSES.CANCELLED) {
      return {
        allowed: false,
        reason: `Não é possível configurar rotações num grupo no estado [${group.status}].`
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador pode visualizar a ordem e as datas estimadas de rotação.
   *
   * @param {object} actingUser
   * @param {object} group
   * @param {boolean} [isMember=false]
   * @returns {boolean}
   */
  canViewRotations(actingUser, group, isMember = false) {
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

  /**
   * Avalia se um membro pode solicitar permuta de posição/mão de recebimento com outro participante.
   * Veda a solicitação se o membro já tiver recebido o montante da Kixikila ou se o turno da contraparte já foi pago.
   *
   * @param {object} actingUser
   * @param {object} requesterTurn - Turno atual do solicitante
   * @param {object} targetTurn - Turno atual do participante com quem deseja permutar
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canRequestTurnSwap(actingUser, requesterTurn, targetTurn) {
    if (!actingUser || !requesterTurn || !targetTurn) {
      return { allowed: false, reason: 'Parâmetros insuficientes para solicitação de troca de turno.' };
    }

    if (actingUser.id !== requesterTurn.beneficiary_user_id) {
      return {
        allowed: false,
        reason: 'Apenas o membro titular do turno pode solicitar a permuta de sua posição de recebimento.'
      };
    }

    if (requesterTurn.beneficiary_user_id === targetTurn.beneficiary_user_id) {
      return {
        allowed: false,
        reason: 'Não é possível efetuar troca de turno consigo próprio.'
      };
    }

    if (requesterTurn.status === ROTATION_STATUSES.PAID_OUT) {
      return {
        allowed: false,
        reason: 'O seu turno já foi liquidado e o montante recebido. Não é permitida a troca retroativa.'
      };
    }

    if (targetTurn.status === ROTATION_STATUSES.PAID_OUT) {
      return {
        allowed: false,
        reason: 'A contraparte já foi contemplada com o bolo da Kixikila neste ciclo. Permuta indisponível.'
      };
    }

    if (requesterTurn.status === ROTATION_STATUSES.CANCELLED || targetTurn.status === ROTATION_STATUSES.CANCELLED) {
      return {
        allowed: false,
        reason: 'Turnos cancelados não são elegíveis para permuta.'
      };
    }

    if (requesterTurn.cycle_number !== targetTurn.cycle_number) {
      return {
        allowed: false,
        reason: 'Permutas só podem ocorrer entre turnos pertencentes rigorosamente ao mesmo ciclo da Kixikila.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador pode homologar formalmente uma troca de turno solicitada.
   *
   * @param {object} actingUser
   * @param {object} group
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canApproveTurnSwap(actingUser, group) {
    if (!actingUser || !group) {
      return { allowed: false, reason: 'Utilizador ou grupo não identificado.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return { allowed: true };
    }

    if (actingUser.id !== group.leader_id && actingUser.id !== group.creator_id) {
      return {
        allowed: false,
        reason: 'A homologação de trocas de turno é reservada à liderança do grupo ou à administração.'
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se a liderança pode reatribuir emergencialmente o turno de recebimento (ex: por inadimplência crônica).
   *
   * @param {object} actingUser
   * @param {object} group
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canEmergencyOverride(actingUser, group) {
    return this.canApproveTurnSwap(actingUser, group);
  }

  /**
   * Valida se uma transição de estado no ciclo do turno de rotação é permitida.
   *
   * @param {string} currentStatus
   * @param {string} newStatus
   * @returns {boolean}
   */
  isValidStatusTransition(currentStatus, newStatus) {
    const validTransitions = {
      PENDING: ['READY_FOR_PAYOUT', 'SKIPPED', 'CANCELLED'],
      READY_FOR_PAYOUT: ['PAID_OUT', 'SKIPPED', 'CANCELLED'],
      SKIPPED: ['READY_FOR_PAYOUT', 'CANCELLED'],
      PAID_OUT: [],
      CANCELLED: []
    };

    const allowed = validTransitions[currentStatus];
    return Boolean(allowed && allowed.includes(newStatus));
  }
}

// Instância singleton da política de rotações
const rotationsPolicy = new RotationsPolicy();

module.exports = rotationsPolicy;