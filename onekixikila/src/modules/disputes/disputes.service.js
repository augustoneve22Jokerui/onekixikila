const crypto = require('crypto');
const disputesRepository = require('./disputes.repository');
const disputesPolicy = require('./disputes.policy');
const groupsRepository = require('../groups/groups.repository');
const contributionsRepository = require('../contributions/contributions.repository');
const { withTransaction } = require('../../database/transaction');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço orquestrador de regras de negócio para Abertura, Mediação e Arbitragem
 * de Disputas e Contestações na plataforma OneKixikila.
 */
class DisputesService {
  /**
   * Abre formalmente uma contestação (disputa) na plataforma.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} disputeData - Dados validados { category, description, groupId, contributionId, amountContested, respondentUserId, evidenceNotes }
   * @param {object} [context={}]
   * @returns {Promise<object>} Registo da disputa criada
   */
  async openDispute(actingUser, disputeData, context = {}) {
    const policyCheck = disputesPolicy.canOpenDispute(actingUser);
    if (!policyCheck.allowed) {
      throw new ConflictError(policyCheck.reason, 'DISPUTE_OPEN_BLOCKED');
    }

    const {
      category,
      description,
      groupId = null,
      contributionId = null,
      ledgerTransactionId = null,
      amountContested = null,
      respondentUserId = null,
      evidenceNotes = null
    } = disputeData;

    // Se vinculada a um grupo, verifica a existência
    if (groupId) {
      const group = await groupsRepository.findById(groupId);
      if (!group) {
        throw NotFoundError.group(groupId);
      }
    }

    // Se vinculada a uma contribuição, verifica a existência
    if (contributionId) {
      const contribution = await contributionsRepository.findById(contributionId);
      if (!contribution) {
        throw NotFoundError.resource('Contribuição', contributionId);
      }
    }

    // Geração do código único e legível da contestação (ex: DSP-A1B2-1729891200)
    const uniqueSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const disputeCode = `DSP-${actingUser.id.slice(0, 4).toUpperCase()}-${Date.now().toString().slice(-6)}-${uniqueSuffix}`;

    const dispute = await withTransaction(async (client) => {
      const created = await disputesRepository.createDispute(
        {
          disputeCode,
          initiatorUserId: actingUser.id,
          respondentUserId,
          groupId,
          contributionId,
          ledgerTransactionId,
          category,
          amountContested: amountContested ? Number(amountContested) : null,
          currency: 'AOA',
          description,
          evidenceNotes
        },
        client
      );

      // Emite evento de domínio assíncrono para alerta aos auditores
      eventBus.publish(
        EVENT_TYPES.DISPUTE_OPENED,
        {
          disputeId: created.id,
          disputeCode: created.dispute_code,
          initiatorUserId: actingUser.id,
          category,
          groupId,
          amountContested: created.amount_contested
        },
        { requestId: context.requestId }
      );

      return created;
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'CREATE',
        resourceType: 'DISPUTE',
        resourceId: dispute.id,
        metadata: {
          disputeCode: dispute.dispute_code,
          category: dispute.category,
          amountContested: dispute.amount_contested
        }
      });
    }

    return {
      message: 'Contestação registada com sucesso. A equipa de mediação e auditoria foi notificada.',
      dispute
    };
  }

  /**
   * Consulta a ficha detalhada de uma disputa com validação Anti-IDOR.
   *
   * @param {object} actingUser
   * @param {string} disputeId
   * @returns {Promise<object>}
   */
  async getDisputeById(actingUser, disputeId) {
    const dispute = await disputesRepository.findById(disputeId);
    if (!dispute) {
      throw NotFoundError.resource('Disputa', disputeId);
    }

    if (!disputesPolicy.canViewDispute(actingUser, dispute)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado aos dados desta contestação.');
    }

    return dispute;
  }

  /**
   * Promove o estado de uma disputa para fase de instrução e investigação ('UNDER_INVESTIGATION').
   *
   * @param {object} actingUser
   * @param {string} disputeId
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async markUnderInvestigation(actingUser, disputeId, context = {}) {
    const dispute = await disputesRepository.findById(disputeId);
    if (!dispute) {
      throw NotFoundError.resource('Disputa', disputeId);
    }

    const check = disputesPolicy.canResolveDispute(actingUser, dispute);
    if (!check.allowed) {
      throw new AuthorizationError(check.reason);
    }

    if (!disputesPolicy.isValidStatusTransition(dispute.status, 'UNDER_INVESTIGATION')) {
      throw new ConflictError(`Transição de estado inválida: [${dispute.status}] -> [UNDER_INVESTIGATION].`);
    }

    const updated = await disputesRepository.markUnderInvestigation(disputeId);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'DISPUTE',
        resourceId: disputeId,
        oldValues: { status: dispute.status },
        newValues: { status: 'UNDER_INVESTIGATION', investigatorId: actingUser.id }
      });
    }

    return updated;
  }

  /**
   * Delibera e encerra uma disputa emitindo o parecer formal de arbitragem.
   *
   * @param {object} actingUser - Auditor ou Administrador
   * @param {string} disputeId - UUID da disputa
   * @param {object} resolutionData - { status, resolutionNotes }
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async resolveDispute(actingUser, disputeId, resolutionData, context = {}) {
    const dispute = await disputesRepository.findById(disputeId);
    if (!dispute) {
      throw NotFoundError.resource('Disputa', disputeId);
    }

    const check = disputesPolicy.canResolveDispute(actingUser, dispute);
    if (!check.allowed) {
      throw new AuthorizationError(check.reason);
    }

    const { status, resolutionNotes } = resolutionData;

    if (!disputesPolicy.isValidStatusTransition(dispute.status, status)) {
      throw new ConflictError(`Transição de estado inválida: [${dispute.status}] -> [${status}].`);
    }

    const resolved = await withTransaction(async (client) => {
      const updated = await disputesRepository.resolveDispute(
        {
          disputeId,
          status,
          resolutionNotes,
          resolvedBy: actingUser.id
        },
        client
      );

      eventBus.publish(
        EVENT_TYPES.DISPUTE_RESOLVED,
        {
          disputeId,
          disputeCode: dispute.dispute_code,
          status,
          resolvedBy: actingUser.id,
          initiatorUserId: dispute.initiator_user_id,
          respondentUserId: dispute.respondent_user_id
        },
        { requestId: context.requestId }
      );

      return updated;
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'STATUS_CHANGE',
        resourceType: 'DISPUTE',
        resourceId: disputeId,
        oldValues: { status: dispute.status },
        newValues: { status, resolutionNotes, resolvedBy: actingUser.id }
      });
    }

    return {
      message: 'Deliberação de arbitragem registada e contestação formalmente encerrada.',
      dispute: resolved
    };
  }

  /**
   * Lista as disputas vinculadas ao próprio utilizador autenticado (iniciadas ou reclamadas).
   *
   * @param {object} user - Utilizador autenticado (req.user)
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listUserDisputes(user, filters, paginationParams) {
    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await disputesRepository.listUserDisputes(user.id, filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }

  /**
   * Lista a fila geral de disputas para a equipa de auditoria e conformidade.
   *
   * @param {object} actingUser
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listAllDisputes(actingUser, filters, paginationParams) {
    if (!disputesPolicy.canResolveDispute(actingUser, { initiator_user_id: 'check-permission-only' })) {
      throw AuthorizationError.insufficientPermissions(actingUser.role, ['ADMIN', 'AUDITOR']);
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await disputesRepository.listAllDisputes(filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }
}

// Instância singleton do serviço de disputas
const disputesService = new DisputesService();

module.exports = disputesService;