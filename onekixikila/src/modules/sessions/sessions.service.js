const sessionsRepository = require('./sessions.repository');
const sessionsPolicy = require('./sessions.policy');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');

/**
 * Serviço de regras de negócio para a gestão de Sessões Ativas, Dispositivos e Revogações
 * na plataforma OneKixikila.
 */
class SessionsService {
  /**
   * Lista as sessões ativas de um utilizador, identificando a sessão em uso corrente.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} targetUserId - UUID da conta a auditar
   * @param {string} [currentSessionId] - ID da sessão da requisição atual
   * @returns {Promise<Array<object>>}
   */
  async listActiveSessions(actingUser, targetUserId, currentSessionId = null) {
    if (!sessionsPolicy.canViewSessions(actingUser, targetUserId)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado às sessões deste utilizador.');
    }

    const sessions = await sessionsRepository.listActiveSessions(targetUserId);

    return sessions.map((session) => ({
      id: session.id,
      deviceId: session.device_id,
      deviceName: session.device_name || 'Dispositivo Desconhecido',
      deviceType: session.device_type || 'OTHER',
      operatingSystem: session.operating_system || 'Desconhecido',
      browser: session.browser || 'Desconhecido',
      ipAddress: session.ip_address,
      createdAt: session.created_at,
      expiresAt: session.expires_at,
      lastActiveAt: session.last_active_at,
      isCurrent: Boolean(currentSessionId && session.id === currentSessionId)
    }));
  }

  /**
   * Revoga formalmente uma sessão individual (Anti-IDOR/BOLA).
   *
   * @param {object} actingUser
   * @param {string} sessionId
   * @param {string} [reason='USER_REVOKED']
   * @param {object} [context={}]
   * @returns {Promise<{ message: string }>}
   */
  async revokeSession(actingUser, sessionId, reason = 'USER_REVOKED', context = {}) {
    const targetSession = await sessionsRepository.findById(sessionId);
    if (!targetSession) {
      throw NotFoundError.resource('Sessão', sessionId);
    }

    const policyResult = sessionsPolicy.canRevokeSession(actingUser, targetSession);
    if (!policyResult.allowed) {
      throw new AuthorizationError(policyResult.reason);
    }

    await sessionsRepository.revokeSession(sessionId, reason);

    eventBus.publish(EVENT_TYPES.AUTH_SESSION_REVOKED, {
      sessionId,
      userId: targetSession.user_id,
      revokedBy: actingUser.id,
      reason
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'DELETE',
        resourceType: 'SESSION',
        resourceId: sessionId,
        metadata: {
          targetUserId: targetSession.user_id,
          reason,
          ipAddress: targetSession.ip_address
        }
      });
    }

    return {
      message: 'Sessão revogada com sucesso.'
    };
  }

  /**
   * Revoga todas as sessões ativas do utilizador exceto a sessão atualmente em uso
   * (funcionalidade "Terminar sessão em todos os outros dispositivos").
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @param {string} currentSessionId
   * @param {string} [reason='REVOKED_OTHER_SESSIONS']
   * @param {object} [context={}]
   * @returns {Promise<{ message: string, revokedCount: number }>}
   */
  async revokeOtherSessions(actingUser, targetUserId, currentSessionId, reason = 'REVOKED_OTHER_SESSIONS', context = {}) {
    if (!sessionsPolicy.canRevokeOtherSessions(actingUser, targetUserId)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado para revogar sessões desta conta.');
    }

    const revokedCount = await sessionsRepository.revokeOtherSessions(targetUserId, currentSessionId, reason);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'DELETE',
        resourceType: 'SESSION_BULK',
        resourceId: targetUserId,
        metadata: {
          preservedSessionId: currentSessionId,
          revokedCount,
          reason
        }
      });
    }

    return {
      message: `${revokedCount} outra(s) sessão(ões) ativa(s) foram encerradas com sucesso.`,
      revokedCount
    };
  }

  /**
   * Encerramento em massa de todas as sessões ativas de um utilizador sem exceção
   * (usado para intervenção administrativa ou isolamento preventivo de segurança).
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @param {string} [reason='ADMIN_REVOKE_ALL']
   * @param {object} [context={}]
   * @returns {Promise<{ message: string, revokedCount: number }>}
   */
  async revokeAllSessions(actingUser, targetUserId, reason = 'ADMIN_REVOKE_ALL', context = {}) {
    if (!sessionsPolicy.canRevokeOtherSessions(actingUser, targetUserId)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado para revogar sessões desta conta.');
    }

    const revokedCount = await sessionsRepository.revokeAllSessions(targetUserId, reason);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'DELETE',
        resourceType: 'SESSION_ALL',
        resourceId: targetUserId,
        metadata: {
          revokedCount,
          reason,
          revokedBy: actingUser.id
        }
      });
    }

    return {
      message: `Todas as sessões ativas (${revokedCount}) do utilizador foram encerradas com sucesso.`,
      revokedCount
    };
  }
}

// Instância singleton do serviço de sessões
const sessionsService = new SessionsService();

module.exports = sessionsService;