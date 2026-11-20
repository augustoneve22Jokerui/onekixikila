const { query } = require('../database/query');

/**
 * Tarefa agendada para expiração, revogação e higienização de sessões de utilizador inativas,
 * além da purga periódica de chaves de idempotência antigas no Neon PostgreSQL.
 */
class SessionCleanupJob {
  /**
   * Executa a rotina de limpeza de sessões expiradas e registros temporários de segurança.
   *
   * @returns {Promise<{
   *   markedExpiredSessions: number,
   *   purgedStaleSessions: number,
   *   purgedIdempotencyKeys: number
   * }>}
   */
  async run() {
    // 1. Marca formalmente como revogadas as sessões cujo prazo expires_at já foi ultrapassado
    const markExpiredQuery = `
      UPDATE sessions
      SET is_revoked = TRUE,
          revoked_at = NOW() AT TIME ZONE 'UTC',
          revoked_reason = 'SESSION_EXPIRED',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE is_revoked = FALSE
        AND expires_at < (NOW() AT TIME ZONE 'UTC');
    `;
    const markExpiredResult = await query(markExpiredQuery);
    const markedExpiredSessions = markExpiredResult.rowCount || 0;

    // 2. Remove da base de dados sessões revogadas há mais de 30 dias (política de retenção de auditoria)
    const purgeSessionsQuery = `
      DELETE FROM sessions
      WHERE is_revoked = TRUE
        AND expires_at < (NOW() AT TIME ZONE 'UTC' - INTERVAL '30 days');
    `;
    const purgeSessionsResult = await query(purgeSessionsQuery);
    const purgedStaleSessions = purgeSessionsResult.rowCount || 0;

    // 3. Purga registros de chaves de idempotência concluídas com mais de 14 dias para evitar inchaço
    const purgeIdempotencyQuery = `
      DELETE FROM idempotency_keys
      WHERE created_at < (NOW() AT TIME ZONE 'UTC' - INTERVAL '14 days');
    `;
    const purgeIdempResult = await query(purgeIdempotencyQuery);
    const purgedIdempotencyKeys = purgeIdempResult.rowCount || 0;

    return {
      markedExpiredSessions,
      purgedStaleSessions,
      purgedIdempotencyKeys
    };
  }
}

// Instância singleton do job
const sessionCleanupJob = new SessionCleanupJob();

module.exports = sessionCleanupJob;