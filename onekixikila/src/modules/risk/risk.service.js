const riskRepository = require('./risk.repository');
const { riskPolicy, RISK_LEVELS, RISK_ACTIONS } = require('./risk.policy');
const walletRepository = require('../wallet/wallet.repository');
const authRepository = require('../auth/auth.repository');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço orquestrador de Regras de Negócio para Avaliação de Risco,
 * Prevenção de Fraudes e Salvaguarda Comportamental na plataforma OneKixikila.
 */
class RiskService {
  /**
   * Avalia e persiste um evento de risco de autenticação (força bruta, credenciais anómalas, IPs rotativos).
   * Aplica ações mitigatórias imediatas quando o teto de risco atinge HIGH ou CRITICAL.
   *
   * @param {object} authRiskData
   * @param {string|null} authRiskData.userId - UUID do utilizador (se identificado)
   * @param {string|null} [authRiskData.ipAddress]
   * @param {string|null} [authRiskData.userAgent]
   * @param {number} [authRiskData.failedAttemptsCount=0]
   * @param {boolean} [authRiskData.isUnknownDevice=false]
   * @param {boolean} [authRiskData.isMultipleIps=false]
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async evaluateAndRecordAuthenticationRisk(authRiskData, context = {}) {
    const {
      userId = null,
      ipAddress = null,
      userAgent = null,
      failedAttemptsCount = 0,
      isUnknownDevice = false,
      isMultipleIps = false
    } = authRiskData;

    // 1. Calcula a avaliação de risco via política
    const evaluation = riskPolicy.evaluateAuthenticationRisk(
      failedAttemptsCount,
      isUnknownDevice,
      isMultipleIps
    );

    const details = {
      score: evaluation.score,
      failedAttemptsCount,
      isUnknownDevice,
      isMultipleIps,
      evaluatedAt: new Date().toISOString()
    };

    // 2. Persistência do evento de risco
    const riskEvent = await riskRepository.createRiskEvent({
      userId,
      eventType: 'AUTH_ANOMALY_DETECTED',
      riskLevel: evaluation.riskLevel,
      ipAddress,
      userAgent,
      details,
      actionTaken: evaluation.actionTaken
    });

    // 3. Aplicação de ações de contenção automáticas em situações severas
    if (evaluation.actionTaken === RISK_ACTIONS.ACCOUNT_FROZEN && userId) {
      // Bloqueia preventivamente a conta e revoga todas as sessões ativas
      await authRepository.updateFailedLoginAttempts(
        userId,
        5,
        new Date(Date.now() + 60 * 60 * 1000) // Bloqueio de 1 hora
      );
      await authRepository.revokeAllUserSessions(userId, 'RISK_AUTO_FREEZE');
    }

    // 4. Emissão de evento de domínio se o risco for relevante
    if (evaluation.riskLevel === RISK_LEVELS.HIGH || evaluation.riskLevel === RISK_LEVELS.CRITICAL) {
      eventBus.publish(
        EVENT_TYPES.RISK_ALERT_TRIGGERED,
        {
          riskEventId: riskEvent.id,
          userId,
          riskLevel: evaluation.riskLevel,
          actionTaken: evaluation.actionTaken,
          score: evaluation.score,
          ipAddress
        },
        { requestId: context.requestId }
      );
    }

    return {
      riskEventId: riskEvent.id,
      riskLevel: evaluation.riskLevel,
      actionTaken: evaluation.actionTaken,
      score: evaluation.score
    };
  }

  /**
   * Avalia e persiste o risco de uma operação financeira em Kwanzas (AOA) antes ou após sua execução.
   * Confronta o montante com o histórico do utilizador e apura rajadas sucessivas.
   *
   * @param {object} txRiskData
   * @param {string} txRiskData.userId - UUID do utilizador
   * @param {number|bigint} txRiskData.transactionAmount - Montante em Kwanzas inteiros
   * @param {string|null} [txRiskData.ipAddress]
   * @param {string|null} [txRiskData.userAgent]
   * @param {object} [txRiskData.details={}]
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async evaluateAndRecordTransactionRisk(txRiskData, context = {}) {
    const {
      userId,
      transactionAmount,
      ipAddress = null,
      userAgent = null,
      details = {}
    } = txRiskData;

    if (!userId) {
      throw ValidationError.fieldRequired('userId');
    }

    // 1. Apura métricas de velocidade recente e histórico financeiro
    const velocity = await riskRepository.getRecentVelocityStats({ userId, windowMinutes: 10 });
    const isRapidSuccession = velocity.totalEvents >= 5;

    const historyStats = await riskRepository.getUserFinancialHistoryStats(userId);

    // 2. Avalia o risco transacional pela política
    const evaluation = riskPolicy.evaluateTransactionRisk(
      transactionAmount,
      historyStats.averageAmount,
      isRapidSuccession
    );

    const mergedDetails = {
      ...details,
      score: evaluation.score,
      transactionAmount: Number(transactionAmount),
      averageUserAmount: Number(historyStats.averageAmount),
      recentVelocity10Min: velocity.totalEvents,
      evaluatedAt: new Date().toISOString()
    };

    // 3. Persistência do evento de risco
    const riskEvent = await riskRepository.createRiskEvent({
      userId,
      eventType: 'TRANSACTION_RISK_EVALUATION',
      riskLevel: evaluation.riskLevel,
      ipAddress,
      userAgent,
      details: mergedDetails,
      actionTaken: evaluation.actionTaken
    });

    // 4. Executa contenção cautelar se o risco financeiro for crítico
    if (evaluation.actionTaken === RISK_ACTIONS.ACCOUNT_FROZEN) {
      const wallet = await walletRepository.findByUserId(userId);
      if (wallet && wallet.status === 'ACTIVE') {
        await walletRepository.updateStatus(wallet.id, 'FROZEN');
        eventBus.publish(EVENT_TYPES.WALLET_FROZEN, {
          walletId: wallet.id,
          userId,
          reason: 'RISK_ENGINE_CRITICAL_TRANSACTION_ALERT'
        }, { requestId: context.requestId });
      }
    }

    if (evaluation.riskLevel === RISK_LEVELS.HIGH || evaluation.riskLevel === RISK_LEVELS.CRITICAL) {
      eventBus.publish(
        EVENT_TYPES.RISK_ALERT_TRIGGERED,
        {
          riskEventId: riskEvent.id,
          userId,
          riskLevel: evaluation.riskLevel,
          actionTaken: evaluation.actionTaken,
          score: evaluation.score,
          transactionAmount: Number(transactionAmount)
        },
        { requestId: context.requestId }
      );
    }

    return {
      riskEventId: riskEvent.id,
      riskLevel: evaluation.riskLevel,
      actionTaken: evaluation.actionTaken,
      score: evaluation.score
    };
  }

  /**
   * Revisa e emite parecer técnico sobre um evento de risco registrado (Ação de Auditor/Admin).
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} eventId - UUID do evento de risco
   * @param {object} reviewData - { actionTaken, notes }
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async reviewRiskEvent(actingUser, eventId, reviewData, context = {}) {
    const riskEvent = await riskRepository.findById(eventId);
    if (!riskEvent) {
      throw NotFoundError.resource('Evento de Risco', eventId);
    }

    const permissionCheck = riskPolicy.canReviewRiskEvent(actingUser, riskEvent);
    if (!permissionCheck.allowed) {
      throw new AuthorizationError(permissionCheck.reason);
    }

    const { actionTaken = null, notes = 'Revisão efetuada por auditoria.' } = reviewData;

    if (actionTaken && !riskPolicy.isValidRiskAction(actionTaken)) {
      throw new ValidationError(`Ação de risco [${actionTaken}] inválida.`);
    }

    const additionalDetails = {
      reviewNotes: notes,
      reviewedByUserId: actingUser.id,
      reviewedAt: new Date().toISOString()
    };

    const updatedEvent = await riskRepository.reviewRiskEvent({
      eventId,
      reviewedBy: actingUser.id,
      actionTaken,
      additionalDetails
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'RISK_EVENT',
        resourceId: eventId,
        metadata: {
          reviewedBy: actingUser.id,
          actionTaken: actionTaken || riskEvent.action_taken,
          notes
        }
      });
    }

    return {
      message: 'Evento de risco auditado e atualizado com sucesso.',
      riskEvent: updatedEvent
    };
  }

  /**
   * Consulta os dados detalhados de um evento de risco por UUID.
   *
   * @param {object} actingUser
   * @param {string} eventId
   * @returns {Promise<object>}
   */
  async getRiskEventById(actingUser, eventId) {
    if (!riskPolicy.canViewRiskEvents(actingUser)) {
      throw AuthorizationError.insufficientPermissions(actingUser ? actingUser.role : 'ANONYMOUS', [
        'ADMIN',
        'AUDITOR'
      ]);
    }

    const event = await riskRepository.findById(eventId);
    if (!event) {
      throw NotFoundError.resource('Evento de Risco', eventId);
    }

    return event;
  }

  /**
   * Lista a esteira de eventos de risco com paginação e filtros para auditores.
   *
   * @param {object} actingUser
   * @param {object} filters - { riskLevel, eventType, actionTaken, userId, isReviewed }
   * @param {object} paginationParams - { page, limit, offset }
   * @returns {Promise<object>}
   */
  async listRiskEvents(actingUser, filters, paginationParams) {
    if (!riskPolicy.canViewRiskEvents(actingUser)) {
      throw AuthorizationError.insufficientPermissions(actingUser ? actingUser.role : 'ANONYMOUS', [
        'ADMIN',
        'AUDITOR'
      ]);
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await riskRepository.listRiskEvents(filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }

  /**
   * Consulta métricas consolidadas de alertas para o painel de governança e monitorização.
   *
   * @param {object} actingUser
   * @returns {Promise<{ unreviewedSevereCount: number, auditedAt: string }>}
   */
  async getRiskOverview(actingUser) {
    if (!riskPolicy.canViewRiskEvents(actingUser)) {
      throw AuthorizationError.insufficientPermissions(actingUser ? actingUser.role : 'ANONYMOUS', [
        'ADMIN',
        'AUDITOR'
      ]);
    }

    const unreviewedSevereCount = await riskRepository.countUnreviewedSevereEvents();

    return {
      unreviewedSevereCount,
      auditedAt: new Date().toISOString()
    };
  }
}

// Instância singleton do serviço de risco
const riskService = new RiskService();

module.exports = riskService;