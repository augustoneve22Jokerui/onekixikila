const leadershipService = require('./leadership.service');

/**
 * Controlador de adaptação HTTP para o módulo de Liderança de Grupos de Kixikila.
 * Recebe pedidos de nomeação de vice-líderes, delegação temporária de poderes,
 * revogação de mandatos e consulta ao histórico de governança para clientes web e móveis.
 */
class LeadershipController {
  /**
   * Delega mandato e poderes de liderança a um membro ativo do grupo.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async delegateLeadership(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const result = await leadershipService.delegateLeadership(req.user, groupId, req.body, {
        requestId: req.id,
        recordAudit: req.recordAudit
      });

      return res.status(201).json({
        success: true,
        message: result.message,
        data: {
          assignment: result.assignment
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Revoga formalmente uma delegação de liderança ativa.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async revokeDelegation(req, res, next) {
    try {
      const { groupId, assignmentId } = req.params;
      const reason = req.body && req.body.reason ? req.body.reason : 'DELEGATION_REVOKED';

      const result = await leadershipService.revokeDelegation(
        req.user,
        groupId,
        assignmentId,
        reason,
        { recordAudit: req.recordAudit }
      );

      return res.status(200).json({
        success: true,
        message: result.message
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Atualiza a matriz de poderes operacionais específicos de um mandato de liderança.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async updatePowers(req, res, next) {
    try {
      const { groupId, assignmentId } = req.params;
      const { powers } = req.body;

      if (!powers || typeof powers !== 'object') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_POWERS_PAYLOAD',
            message: 'O objeto com a matriz de poderes (powers) é obrigatório.'
          }
        });
      }

      const updated = await leadershipService.updatePowers(
        req.user,
        groupId,
        assignmentId,
        powers,
        { recordAudit: req.recordAudit }
      );

      return res.status(200).json({
        success: true,
        message: 'Poderes de liderança atualizados com sucesso.',
        data: {
          assignment: updated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta a composição da liderança ativa do grupo (Líder titular, vice-líderes e interinos).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getActiveLeadership(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const leaders = await leadershipService.getActiveLeadership(req.user, groupId);

      return res.status(200).json({
        success: true,
        data: {
          leaders
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta o histórico institucional de governança e mandatos anteriores do grupo.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getLeadershipHistory(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const history = await leadershipService.getLeadershipHistory(req.user, groupId);

      return res.status(200).json({
        success: true,
        data: {
          history
        }
      });
    } catch (error) {
      return next(error);
    }
  }
}

// Instância singleton do controlador com vinculação de contexto
const leadershipController = new LeadershipController();
leadershipController.delegateLeadership = leadershipController.delegateLeadership.bind(leadershipController);
leadershipController.revokeDelegation = leadershipController.revokeDelegation.bind(leadershipController);
leadershipController.updatePowers = leadershipController.updatePowers.bind(leadershipController);
leadershipController.getActiveLeadership = leadershipController.getActiveLeadership.bind(leadershipController);
leadershipController.getLeadershipHistory = leadershipController.getLeadershipHistory.bind(leadershipController);

module.exports = leadershipController;