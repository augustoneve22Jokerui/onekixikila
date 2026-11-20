// =============================================================================
// modules/chat/moderation.service.js
// =============================================================================

const chatRepository = require('./chat.repository');
const { chatPolicy } = require('./chat.policy');
const groupsRepository = require('../groups/groups.repository');
const membershipsRepository = require('../memberships/memberships.repository');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço de regras de negócio para Denúncias, Mediação Comunitária
 * e Moderação de Conduta no chat dos Grupos de Kixikila.
 */
class ModerationService {
  async reportMessage(actingUser, groupId, messageId, reason, context = {}) {
    if (!groupId) {
      throw ValidationError.fieldRequired('groupId');
    }
    if (!messageId) {
      throw ValidationError.fieldRequired('messageId');
    }
    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
      throw new ValidationError('A justificativa da denúncia deve conter pelo menos 5 caracteres.');
    }

    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const message = await chatRepository.findById(messageId);
    if (!message) {
      throw NotFoundError.resource('Mensagem', messageId);
    }

    if (message.group_id !== groupId) {
      throw new ConflictError('A mensagem denunciada não pertence a este grupo de Kixikila.');
    }

    const check = chatPolicy.canReportMessage(actingUser, message);
    if (!check.allowed) {
      throw new ConflictError(check.reason);
    }

    const createdReport = await chatRepository.createReport({
      messageId,
      groupId,
      reportedBy: actingUser.id,
      reason: reason.trim()
    });

    eventBus.publish(
      EVENT_TYPES.CHAT_MESSAGE_REPORTED,
      {
        reportId: createdReport.id,
        groupId,
        messageId,
        reportedBy: actingUser.id,
        reportedSenderId: message.sender_id,
        reason: createdReport.reason
      },
      { requestId: context.requestId }
    );

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'CREATE',
        resourceType: 'CHAT_REPORT',
        resourceId: createdReport.id,
        metadata: {
          groupId,
          messageId,
          reportedBy: actingUser.id
        }
      });
    }

    return {
      message:
        'Denúncia registada com sucesso. A liderança do grupo e a moderação foram notificadas.',
      report: createdReport
    };
  }

  async resolveReport(actingUser, reportId, resolutionData, context = {}) {
    const report = await chatRepository.findReportById(reportId);
    if (!report) {
      throw NotFoundError.resource('Denúncia', reportId);
    }

    if (report.status !== 'PENDING') {
      throw new ConflictError(
        `Esta denúncia já se encontra no estado [${report.status}] e não pode sofrer nova deliberação.`
      );
    }

    const group = await groupsRepository.findById(report.group_id);
    const isLeader =
      group && (group.leader_id === actingUser.id || group.creator_id === actingUser.id);

    const check = chatPolicy.canModerateReport(actingUser, isLeader);
    if (!check.allowed) {
      throw new AuthorizationError(check.reason);
    }

    const {
      status,
      resolutionNotes = 'Parecer emitido pela moderação.',
      actionToTake = 'NONE'
    } = resolutionData;

    if (
      status === 'ACTION_TAKEN' ||
      actionToTake === 'DELETE_MESSAGE' ||
      actionToTake === 'BAN_USER_CHAT'
    ) {
      await chatRepository.softDeleteMessage(report.message_id, actingUser.id);
    }

    if (actionToTake === 'BAN_USER_CHAT' && report.reported_message_sender_id) {
      const offenderMembership = await membershipsRepository.findByGroupAndUser(
        report.group_id,
        report.reported_message_sender_id
      );

      if (offenderMembership) {
        await membershipsRepository.updateRestrictions(offenderMembership.id, {
          isBannedFromChat: true
        });
      }
    }

    const updatedReport = await chatRepository.updateReportResolution({
      reportId,
      status,
      reviewedBy: actingUser.id,
      resolutionNotes
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'CHAT_REPORT_RESOLUTION',
        resourceId: reportId,
        oldValues: { status: report.status },
        newValues: { status, resolutionNotes, actionToTake, reviewedBy: actingUser.id }
      });
    }

    return {
      message: 'Denúncia deliberada e resolvida com sucesso.',
      report: updatedReport
    };
  }

  async listGroupReports(actingUser, groupId, filters, paginationParams) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const isLeader =
      group && (group.leader_id === actingUser.id || group.creator_id === actingUser.id);
    const check = chatPolicy.canModerateReport(actingUser, isLeader);
    if (!check.allowed) {
      throw new AuthorizationError(check.reason);
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await chatRepository.listGroupReports(groupId, filters, {
      limit,
      offset
    });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }
}

const moderationService = new ModerationService();

module.exports = moderationService;