const schedulesService = require('./schedules.service');

/**
 * Controlador de adaptação HTTP para o módulo de Calendários e Cronogramas de Kixikila.
 * Recebe e trata requisições para geração de cronogramas de ciclo, ativação de rodadas,
 * conclusão de turnos de contribuição, consulta de quotas e detalhamento de vencimentos.
 */
class SchedulesController {
  /**
   * Gera o cronograma completo de rodadas para o ciclo ativo da Kixikila.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async generateSchedule(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const rounds = await schedulesService.generateCycleSchedule(req.user, groupId, {
        requestId: req.id,
        recordAudit: req.recordAudit
      });

      return res.status(201).json({
        success: true,
        message: 'Cronograma de rodadas gerado com sucesso.',
        data: {
          rounds
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Ativa formalmente uma rodada de calendário (SCHEDULED -> ACTIVE) emitindo as quotas exigíveis.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async activateRound(req, res, next) {
    try {
      const scheduleId = req.params.scheduleId;
      const activated = await schedulesService.activateRound(req.user, scheduleId, {
        requestId: req.id,
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: 'Rodada de contribuição ativada com sucesso.',
        data: {
          round: activated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Conclui uma rodada após a verificação de quitação integral das quotas.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async completeRound(req, res, next) {
    try {
      const scheduleId = req.params.scheduleId;
      const completed = await schedulesService.completeRound(req.user, scheduleId, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: 'Rodada de contribuição concluída com sucesso.',
        data: {
          round: completed
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta o cronograma de rodadas de um grupo de Kixikila.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getGroupSchedule(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const cycleNumber = req.query.cycleNumber ? Number(req.query.cycleNumber) : null;

      const schedule = await schedulesService.getGroupSchedule(req.user, groupId, cycleNumber);

      return res.status(200).json({
        success: true,
        data: {
          schedule
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta os detalhes de uma rodada específica com a lista de quotas exigíveis de cada membro.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getRoundDetails(req, res, next) {
    try {
      const scheduleId = req.params.scheduleId;
      const details = await schedulesService.getRoundDetails(req.user, scheduleId);

      return res.status(200).json({
        success: true,
        data: details
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta as quotas a vencer do próprio utilizador autenticado em todos os seus grupos.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getMyUpcomingObligations(req, res, next) {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 10;
      const obligations = await schedulesService.getMyUpcomingObligations(req.user, limit);

      return res.status(200).json({
        success: true,
        data: {
          obligations
        }
      });
    } catch (error) {
      return next(error);
    }
  }
}

// Instância singleton do controlador com vinculação de contexto
const schedulesController = new SchedulesController();
schedulesController.generateSchedule = schedulesController.generateSchedule.bind(schedulesController);
schedulesController.activateRound = schedulesController.activateRound.bind(schedulesController);
schedulesController.completeRound = schedulesController.completeRound.bind(schedulesController);
schedulesController.getGroupSchedule = schedulesController.getGroupSchedule.bind(schedulesController);
schedulesController.getRoundDetails = schedulesController.getRoundDetails.bind(schedulesController);
schedulesController.getMyUpcomingObligations = schedulesController.getMyUpcomingObligations.bind(schedulesController);

module.exports = schedulesController;