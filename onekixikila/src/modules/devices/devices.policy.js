const { USER_ROLES, ADMINISTRATIVE_ROLES } = require('../../shared/constants/roles');
const { USER_STATUSES } = require('../../shared/constants/statuses');

// Limite máximo de aparelhos associados permitidos por conta de utilizador
const MAX_DEVICES_PER_ACCOUNT = 10;

/**
 * Políticas de autorização, controlo de acesso baseado em função (RBAC)
 * e proteção contra IDOR/BOLA para a gestão de dispositivos na plataforma OneKixikila.
 */
class DevicesPolicy {
  /**
   * Avalia se o utilizador atuante possui autorização para listar os aparelhos vinculados a uma conta.
   * O próprio titular pode consultar os seus aparelhos; agentes com papéis administrativos
   * (ADMIN, AUDITOR, SUPPORT_AGENT) podem consultar para fins de diagnóstico e segurança.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} targetUserId - UUID da conta cujos dispositivos são requisitados
   * @returns {boolean}
   */
  canViewDevices(actingUser, targetUserId) {
    if (!actingUser || actingUser.status === USER_STATUSES.BLOCKED || actingUser.status === USER_STATUSES.DEACTIVATED) {
      return false;
    }

    if (actingUser.id === targetUserId) {
      return true;
    }

    return ADMINISTRATIVE_ROLES.includes(actingUser.role);
  }

  /**
   * Avalia se o utilizador atuante possui permissão para modificar ou remover determinado aparelho (Anti-IDOR).
   *
   * @param {object} actingUser
   * @param {object} targetDevice - Registo do dispositivo obtido da base de dados
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canManageDevice(actingUser, targetDevice) {
    if (!actingUser || !targetDevice) {
      return { allowed: false, reason: 'Utilizador ou dispositivo não identificado.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return { allowed: true };
    }

    if (actingUser.id !== targetDevice.user_id) {
      return {
        allowed: false,
        reason: 'Não possui autorização para gerir dispositivos pertencentes a outro utilizador.'
      };
    }

    if (actingUser.status === USER_STATUSES.BLOCKED || actingUser.status === USER_STATUSES.SUSPENDED) {
      return {
        allowed: false,
        reason: `A sua conta encontra-se no estado [${actingUser.status}]. Operação não permitida.`
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador pode marcar um aparelho como confiável (Trusted Device).
   * Ação estritamente reservada ao próprio titular da conta.
   *
   * @param {object} actingUser
   * @param {object} targetDevice
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canTrustDevice(actingUser, targetDevice) {
    if (!actingUser || !targetDevice) {
      return { allowed: false, reason: 'Utilizador ou dispositivo não identificado.' };
    }

    if (actingUser.id !== targetDevice.user_id) {
      return {
        allowed: false,
        reason: 'Apenas o titular da conta pode marcar um aparelho como confiável.'
      };
    }

    return { allowed: true };
  }

  /**
   * Verifica se a quantidade de aparelhos cadastrados atingiu o teto máximo permitido.
   *
   * @param {number} currentCount
   * @returns {boolean} True se atingir ou exceder o limite
   */
  isDeviceLimitReached(currentCount) {
    return (Number(currentCount) || 0) >= MAX_DEVICES_PER_ACCOUNT;
  }
}

// Instância singleton da política de dispositivos
const devicesPolicy = new DevicesPolicy();

module.exports = devicesPolicy;