const devicesRepository = require('./devices.repository');
const devicesPolicy = require('./devices.policy');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');

/**
 * Serviço de regras de negócio para a gestão de Dispositivos e Aparelhos Conectados
 * na plataforma OneKixikila.
 */
class DevicesService {
  /**
   * Lista todos os aparelhos vinculados à conta de um utilizador.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} targetUserId - UUID da conta a consultar
   * @returns {Promise<Array<object>>}
   */
  async listUserDevices(actingUser, targetUserId) {
    if (!devicesPolicy.canViewDevices(actingUser, targetUserId)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado aos dispositivos desta conta.');
    }

    return devicesRepository.listUserDevices(targetUserId);
  }

  /**
   * Obtém os detalhes de um aparelho específico pelo seu identificador.
   *
   * @param {object} actingUser
   * @param {string} deviceId
   * @returns {Promise<object>}
   */
  async getDevice(actingUser, deviceId) {
    const device = await devicesRepository.findById(deviceId);
    if (!device) {
      throw NotFoundError.resource('Dispositivo', deviceId);
    }

    const policyResult = devicesPolicy.canManageDevice(actingUser, device);
    if (!policyResult.allowed) {
      throw new AuthorizationError(policyResult.reason);
    }

    return device;
  }

  /**
   * Regista ou atualiza os metadados de acesso de um aparelho no login ou inicialização da aplicação.
   *
   * @param {object} deviceData
   * @returns {Promise<object>}
   */
  async registerOrUpdateDevice(deviceData) {
    return devicesRepository.upsertDevice(deviceData);
  }

  /**
   * Vincula ou atualiza o token de notificação móvel (Push Token - FCM/APNS) do aparelho.
   *
   * @param {object} actingUser
   * @param {string} deviceId
   * @param {string} pushToken
   * @returns {Promise<object>}
   */
  async updatePushToken(actingUser, deviceId, pushToken) {
    const device = await devicesRepository.findById(deviceId);
    if (!device) {
      throw NotFoundError.resource('Dispositivo', deviceId);
    }

    const policyResult = devicesPolicy.canManageDevice(actingUser, device);
    if (!policyResult.allowed) {
      throw new AuthorizationError(policyResult.reason);
    }

    return devicesRepository.updatePushToken(deviceId, pushToken);
  }

  /**
   * Altera a classificação de confiabilidade do aparelho (Marcar/Desmarcar como Trusted Device).
   *
   * @param {object} actingUser
   * @param {string} deviceId
   * @param {boolean} isTrusted
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async updateTrustStatus(actingUser, deviceId, isTrusted, context = {}) {
    const device = await devicesRepository.findById(deviceId);
    if (!device) {
      throw NotFoundError.resource('Dispositivo', deviceId);
    }

    const policyResult = devicesPolicy.canTrustDevice(actingUser, device);
    if (!policyResult.allowed) {
      throw new AuthorizationError(policyResult.reason);
    }

    const updatedDevice = await devicesRepository.updateTrustStatus(deviceId, isTrusted);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'DEVICE_TRUST',
        resourceId: deviceId,
        oldValues: { isTrusted: device.is_trusted },
        newValues: { isTrusted },
        metadata: {
          deviceName: device.device_name,
          operatingSystem: device.operating_system
        }
      });
    }

    return updatedDevice;
  }

  /**
   * Remove o registo de um aparelho vinculado à conta do utilizador.
   *
   * @param {object} actingUser
   * @param {string} deviceId
   * @param {object} [context={}]
   * @returns {Promise<{ message: string }>}
   */
  async removeDevice(actingUser, deviceId, context = {}) {
    const device = await devicesRepository.findById(deviceId);
    if (!device) {
      throw NotFoundError.resource('Dispositivo', deviceId);
    }

    const policyResult = devicesPolicy.canManageDevice(actingUser, device);
    if (!policyResult.allowed) {
      throw new AuthorizationError(policyResult.reason);
    }

    await devicesRepository.deleteDevice(deviceId);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'DELETE',
        resourceType: 'USER_DEVICE',
        resourceId: deviceId,
        metadata: {
          deviceName: device.device_name,
          deviceType: device.device_type,
          lastIp: device.last_ip_address
        }
      });
    }

    return {
      message: 'Dispositivo removido com sucesso da sua conta.'
    };
  }
}

// Instância singleton do serviço de dispositivos
const devicesService = new DevicesService();

module.exports = devicesService;