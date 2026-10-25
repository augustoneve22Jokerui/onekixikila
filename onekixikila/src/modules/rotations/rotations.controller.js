const rotationsService = require('./rotations.service');

/**
 * Controlador de adaptação HTTP para o módulo de Rotações e Ordem de Beneficiários de Kixikila.
 * Gerencia a definição do calendário de recebimento ("mãos" da Kixikila), solicitações
 * de troca amigável de turnos entre membros (Swap), aprovações pela liderança,
 * intervenções emergenciais de turno e consulta de datas estimadas de contemplação.
 */
class RotationsController {
  /**
   * Gera ou estabelece o plano formal de rotação para o ciclo ativo do grupo.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async generateRotationPlan(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const result = await rotationsService.generateRotationPlan(req.user, groupId, req.body, {
        requestId: req.id,
        recordAudit: req.recordAudit
      });

      return res.status(201).json({
        success: true,
        message: result.message,
        data: {
          rotations: result.rotations
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta o plano completo de turnos e beneficiários de um grupo em determinado ciclo.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getGroupRotations(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const cycleNumber = req.query.cycleNumber ? Number(req.query.cycleNumber) : null;

      const rotations = await rotationsService.getGroupRotations(req.user, groupId, cycleNumber);

      return res.status(200).json({
        success: true,
        data: {
          rotations
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Solicita formalmente uma troca de posição/turno de recebimento entre dois membros do grupo.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async requestTurnSwap(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const result = await rotationsService.requestTurnSwap(req.user, groupId, req.body, {
        requestId: req.id,
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message,
        data: result.swapDetails
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Aprova formalmente uma permuta de turno pendente (por líder titular ou contraparte envolvida).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async approveTurnSwap(req, res, next) {
    try {
      const { groupId, assignmentId } = req.params;
      const result = await rotationsService.approveTurnSwap(req.user, groupId, assignmentId, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message,
        data: result.updatedAssignments
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Rejeita ou cancela uma solicitação de troca de turno.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async rejectTurnSwap(req, res, next) {
    try {
      const { groupId, assignmentId } = req.params;
      const reason = req.body && req.body.reason ? req.body.reason : 'Rejeitado pela liderança ou membro';

      const result = await rotationsService.rejectTurnSwap(req.user, groupId, assignmentId, reason, {
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

  /**
   * Reatribui emergencialmente um turno de recebimento (Ação da liderança por deliberação ou inadimplência).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async emergencyOverrideTurn(req, res, next) {
    try {
      const { groupId, rotationId } = req.params;
      const result = await rotationsService.emergencyOverrideTurn(req.user, groupId, rotationId, req.body, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message,
        data: result.assignment
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta os turnos em que o próprio utilizador autenticado é o beneficiário contemplado em todos os seus grupos.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getMyUpcomingTurns(req, res, next) {
    try {
      const turns = await rotationsService.getMyUpcomingTurns(req.user);

      return res.status(200).json({
        success: true,
        data: {
          turns
        }
      });
    } catch (error) {
      return next(error);
    }
  }
}

// Instância singleton do controlador com vinculação de contexto
const rotationsController = new RotationsController();
rotationsController.generateRotationPlan = rotationsController.generateRotationPlan.bind(rotationsController);
rotationsController.getGroupRotations = rotationsController.getGroupRotations.bind(rotationsController);
rotationsController.requestTurnSwap = rotationsController.requestTurnSwap.bind(rotationsController);
rotationsController.approveTurnSwap = rotationsController.approveTurnSwap.bind(rotationsController);
rotationsController.rejectTurnSwap = rotationsController.rejectTurnSwap.bind(rotationsController);
rotationsController.emergencyOverrideTurn = rotationsController.emergencyOverrideTurn.bind(rotationsController);
rotationsController.getMyUpcomingTurns = rotationsController.getMyUpcomingTurns.bind(rotationsController);

module.exports = rotationsController;