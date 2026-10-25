const { USER_ROLES } = require('../../shared/constants/roles');
const { QR_TOKEN_STATUSES } = require('../../shared/constants/statuses');

/**
 * Políticas de autorização, integridade de escaneamento e segurança anti-repetição
 * para o módulo de Códigos QR da plataforma OneKixikila.
 */
class QrPolicy {
  /**
   * Avalia se um token QR está apto e elegível para leitura ou consumo financeiro.
   * Valida estado ativo, limite de escaneamentos e prazo de validade temporal.
   *
   * @param {object} qrToken - Registro da tabela qr_tokens
   * @returns {{ usable: boolean, reason?: string }}
   */
  isQrTokenUsable(qrToken) {
    if (!qrToken) {
      return { usable: false, reason: 'Código QR não localizado ou inválido.' };
    }

    if (qrToken.status === QR_TOKEN_STATUSES.REVOKED) {
      return { usable: false, reason: 'Este Código QR foi cancelado pelo emissor.' };
    }

    if (qrToken.status === QR_TOKEN_STATUSES.USED) {
      return { usable: false, reason: 'Este Código QR já foi utilizado e consumido.' };
    }

    if (qrToken.status === QR_TOKEN_STATUSES.EXPIRED) {
      return { usable: false, reason: 'Este Código QR expirou.' };
    }

    // Validação estrita do timestamp de expiração
    if (new Date(qrToken.expires_at).getTime() < Date.now()) {
      return { usable: false, reason: 'O prazo de validade deste Código QR expirou.' };
    }

    // Validação da cota máxima de escaneamentos autorizados
    const currentScans = Number(qrToken.scan_count) || 0;
    const maxScans = Number(qrToken.max_scans) || 1;

    if (currentScans >= maxScans) {
      return {
        usable: false,
        reason: 'Este Código QR atingiu o número máximo de utilizações autorizadas.'
      };
    }

    return { usable: true };
  }

  /**
   * Avalia se o utilizador atuante detém permissão para revogar determinado token QR (Anti-IDOR).
   * Apenas o emissor original ou Administradores da plataforma possuem autorização.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} qrToken - Registro do token QR
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canRevokeQrToken(actingUser, qrToken) {
    if (!actingUser || !qrToken) {
      return { allowed: false, reason: 'Parâmetros insuficientes para revogação.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return { allowed: true };
    }

    if (actingUser.id !== qrToken.creator_user_id) {
      return {
        allowed: false,
        reason: 'Não possui autorização para revogar Códigos QR gerados por outro utilizador.'
      };
    }

    if (qrToken.status !== QR_TOKEN_STATUSES.ACTIVE) {
      return {
        allowed: false,
        reason: `Este Código QR já se encontra no estado [${qrToken.status}] e não pode ser revogado.`
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador possui permissão para consultar os detalhes de auditoria de um token QR.
   *
   * @param {object} actingUser
   * @param {object} qrToken
   * @returns {boolean}
   */
  canViewQrToken(actingUser, qrToken) {
    if (!actingUser || !qrToken) {
      return false;
    }

    if (actingUser.role === USER_ROLES.ADMIN || actingUser.role === USER_ROLES.AUDITOR) {
      return true;
    }

    return actingUser.id === qrToken.creator_user_id;
  }

  /**
   * Valida as transições de estado permitidas para um token QR no banco de dados.
   *
   * @param {string} currentStatus
   * @param {string} newStatus
   * @returns {boolean}
   */
  isValidStatusTransition(currentStatus, newStatus) {
    const validTransitions = {
      ACTIVE: ['USED', 'EXPIRED', 'REVOKED'],
      USED: [],
      EXPIRED: [],
      REVOKED: []
    };

    const allowed = validTransitions[currentStatus];
    return Boolean(allowed && allowed.includes(newStatus));
  }
}

// Instância singleton da política de QR
const qrPolicy = new QrPolicy();

module.exports = qrPolicy;