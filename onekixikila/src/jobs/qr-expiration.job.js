const { query } = require('../database/query');

/**
 * Tarefa agendada para expiração e invalidação de códigos QR de cobrança,
 * tokens de transferência direta e convites de grupos com prazos vencidos.
 */
class QrExpirationJob {
  /**
   * Executa a rotina de varredura e atualização de tokens expirados.
   *
   * @returns {Promise<{
   *   expiredQrTokens: number,
   *   consumedQrTokens: number,
   *   expiredInvitations: number
   * }>}
   */
  async run() {
    // 1. Marca como EXPIRED os QR tokens com prazo de validade ultrapassado
    const expireQrQuery = `
      UPDATE qr_tokens
      SET status = 'EXPIRED',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE status = 'ACTIVE'
        AND expires_at < (NOW() AT TIME ZONE 'UTC');
    `;
    const expireQrResult = await query(expireQrQuery);
    const expiredQrTokens = expireQrResult.rowCount || 0;

    // 2. Marca como USED os QR tokens que atingiram o teto de leituras autorizadas
    const consumeQrQuery = `
      UPDATE qr_tokens
      SET status = 'USED',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE status = 'ACTIVE'
        AND scan_count >= max_scans;
    `;
    const consumeQrResult = await query(consumeQrQuery);
    const consumedQrTokens = consumeQrResult.rowCount || 0;

    // 3. Marca como EXPIRED os convites de grupos (group_invitations) com validade expirada
    const expireInvitationsQuery = `
      UPDATE group_invitations
      SET status = 'EXPIRED',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE status = 'PENDING'
        AND expires_at < (NOW() AT TIME ZONE 'UTC');
    `;
    const expireInvResult = await query(expireInvitationsQuery);
    const expiredInvitations = expireInvResult.rowCount || 0;

    return {
      expiredQrTokens,
      consumedQrTokens,
      expiredInvitations
    };
  }
}

// Instância singleton do job
const qrExpirationJob = new QrExpirationJob();

module.exports = qrExpirationJob;