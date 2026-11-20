const auditRepository = require('./audit.repository');
const { auditPolicy } = require('./audit.policy');
const { redactSensitive } = require('../../shared/logging/redaction');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço de regras de negócio para a Trilha de Auditoria Institucional e Rastreabilidade Forense
 * da plataforma OneKixikila.
 * Garante o expurgo prévio de segredos em todas as gravações, persistência imutável (append-only),
 * consultas supervisionadas com privilégios mínimos e disponibilização do histórico de segurança pessoal.
 */
class AuditService {
  /**
   * Grava um novo evento de auditoria no sistema com sanitização profunda de dados sensíveis.
   *
   * @param {object} eventData
   * @param {string|null} [eventData.requestId=null]
   * @param {string|null} [eventData.actorUserId=null]
   * @param {string|null} [eventData.actorRole='ANONYMOUS']
   * @param {string|null} [eventData.ipAddress=null]
   * @param {string|null} [eventData.userAgent=null]
   * @param {string} eventData.action
   * @param {string} eventData.resourceType
   * @param {string|null} [eventData.resourceId=null]
   * @param {object|null} [eventData.oldValues=null]
   * @param {object|null} [eventData.newValues=null]
   * @param {object} [eventData.metadata={}]
   * @param {import('pg').PoolClient} [client=null] - Conexão transacional opcional
   * @returns {Promise<object>} Registo gravado
   */
  async recordEvent(eventData, client = null) {
    if (!eventData.action || !eventData.resourceType) {
      throw ValidationError.fieldRequired('action e resourceType');
    }

    // Sanitização e expurgo estrito de dados sensíveis antes da persistência
    const sanitizedOld = eventData.oldValues ? redactSensitive(eventData.oldValues) : null;
    const sanitizedNew = eventData.newValues ? redactSensitive(eventData.newValues) : null;
    const sanitizedMeta = eventData.metadata ? redactSensitive(eventData.metadata) : {};

    return auditRepository.recordAuditEvent(
      {
        requestId: eventData.requestId || null,
        actorUserId: eventData.actorUserId || null,
        actorRole: eventData.actorRole || 'ANONYMOUS',
        ipAddress: eventData.ipAddress || null,
        userAgent: eventData.userAgent || null,
        action: eventData.action,
        resourceType: eventData.resourceType,
        resourceId: eventData.resourceId || null,
        oldValues: sanitizedOld,
        newValues: sanitizedNew,
        metadata: sanitizedMeta
      },
      client
    );
  }

  /**
   * Consulta os dados detalhados de um evento de auditoria específico por UUID.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} eventId - UUID do evento
   * @returns {Promise<object>}
   */
  async getEventById(actingUser, eventId) {
    const accessCheck = auditPolicy.canViewAuditLogs(actingUser);
    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    const event = await auditRepository.findById(eventId);
    if (!event) {
      throw NotFoundError.resource('Evento de Auditoria', eventId);
    }

    return event;
  }

  /**
   * Consulta paginada e filtrada de eventos de auditoria institucional.
   *
   * @param {object} actingUser
   * @param {object} filters - { action, resourceType, actorUserId, resourceId, requestId, startDate, endDate }
   * @param {object} paginationParams - { page, limit, offset }
   * @returns {Promise<object>}
   */
  async listAuditEvents(actingUser, filters, paginationParams) {
    const accessCheck = auditPolicy.canViewAuditLogs(actingUser);
    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    const filterCheck = auditPolicy.validateAuditFilters(filters);
    if (!filterCheck.valid) {
      throw new ValidationError(filterCheck.reason);
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await auditRepository.listAuditEvents(filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }

  /**
   * Consulta o histórico de segurança e acesso do próprio utilizador autenticado
   * (Logins, encerramentos de sessão, alteração de palavra-passe e dispositivos).
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @param {object} paginationParams - { page, limit, offset }
   * @returns {Promise<object>}
   */
  async getUserSecurityHistory(actingUser, targetUserId, paginationParams) {
    if (!auditPolicy.canViewOwnSecurityHistory(actingUser, targetUserId)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado ao histórico de segurança deste utilizador.');
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await auditRepository.getUserSecurityHistory(targetUserId, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }

  /**
   * Retorna métricas volumétricas da esteira de auditoria institucional para relatórios de conformidade.
   *
   * @param {object} actingUser
   * @param {object} periodParams - { periodStart, periodEnd }
   * @returns {Promise<{ eventCount: number, period: object }>}
   */
  async getAuditMetrics(actingUser, periodParams = {}) {
    const accessCheck = auditPolicy.canViewAuditLogs(actingUser);
    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    const start = periodParams.periodStart ? new Date(periodParams.periodStart) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = periodParams.periodEnd ? new Date(periodParams.periodEnd) : new Date();

    const count = await auditRepository.countEventsByPeriod(start, end);

    return {
      eventCount: count,
      period: {
        start: start.toISOString(),
        end: end.toISOString()
      }
    };
  }
}

// Instância singleton do serviço de auditoria
const auditService = new AuditService();

module.exports = auditService;