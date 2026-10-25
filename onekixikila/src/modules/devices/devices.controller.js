const devicesService = require('./devices.service');

/**
 * Controlador de adaptação HTTP para gestão de Dispositivos e Aparelhos Conectados.
 * Trata pedidos de listagem de terminais vinculados, registro de tokens de notificação push,
 * classificação de aparelhos confiáveis (Trusted Devices) e desvinculação de hardware.
 */
class DevicesController {
  /**
   * Consulta os aparelhos vinculados à conta do próprio utilizador autenticado.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listMyDevices(req, res, next) {
    try {
      const devices = await devicesService.listUserDevices(req.user, req.user.id);

      return res.status(200).json({
        success: true,
        data: {
          devices
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta administrativa dos aparelhos vinculados a um utilizador específico.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listUserDevices(req, res, next) {
    try {
      const targetUserId = req.params.userId;
      const devices = await devicesService.listUserDevices(req.user, targetUserId);

      return res.status(200).json({
        success: true,
        data: {
          devices
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Obtém os detalhes técnicos de um aparelho específico.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getDevice(req, res, next) {
    try {
      const deviceId = req.params.deviceId;
      const device = await devicesService.getDevice(req.user, deviceId);

      return res.status(200).json({
        success: true,
        data: {
          device
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Atualiza o token de notificações push do aparelho (FCM/APNS).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async updatePushToken(req, res, next) {
    try {
      const deviceId = req.params.deviceId;
      const { pushToken } = req.body;

      if (!pushToken || typeof pushToken !== 'string') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_PUSH_TOKEN',
            message: 'O pushToken fornecido é inválido ou está vazio.'
          }
        });
      }

      const updated = await devicesService.updatePushToken(req.user, deviceId, pushToken.trim());

      return res.status(200).json({
        success: true,
        message: 'Token de notificações atualizado com sucesso.',
        data: {
          device: updated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Modifica a marcação de confiabilidade de um aparelho (Trusted Device).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async updateTrustStatus(req, res, next) {
    try {
      const deviceId = req.params.deviceId;
      const { isTrusted } = req.body;

      if (typeof isTrusted !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_TRUST_STATUS',
            message: "O campo isTrusted deve ser um valor booleano (true ou false)."
          }
        });
      }

      const updated = await devicesService.updateTrustStatus(
        req.user,
        deviceId,
        isTrusted,
        { recordAudit: req.recordAudit }
      );

      return res.status(200).json({
        success: true,
        message: `Dispositivo marcado como ${isTrusted ? 'confiável' : 'não confiável'}.`,
        data: {
          device: updated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Remove o vínculo de um aparelho da conta de utilizador.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async removeDevice(req, res, next) {
    try {
      const deviceId = req.params.deviceId;
      const result = await devicesService.removeDevice(req.user, deviceId, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message
      });
    } catch (error) {
      return next(error);
    }
  }
}

// Instância singleton do controlador com vinculação de contexto
const devicesController = new DevicesController();
devicesController.listMyDevices = devicesController.listMyDevices.bind(devicesController);
devicesController.listUserDevices = devicesController.listUserDevices.bind(devicesController);
devicesController.getDevice = devicesController.getDevice.bind(devicesController);
devicesController.updatePushToken = devicesController.updatePushToken.bind(devicesController);
devicesController.updateTrustStatus = devicesController.updateTrustStatus.bind(devicesController);
devicesController.removeDevice = devicesController.removeDevice.bind(devicesController);

module.exports = devicesController;