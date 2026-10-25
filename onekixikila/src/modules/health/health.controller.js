const healthService = require('./health.service');

/**
 * Controlador de adaptação HTTP para sondas de integridade e prontidão (Health Check).
 * Responde aos health checks de monitorização e balanceamento de carga do Render,
 * retornando HTTP 200 (Healthy) ou HTTP 503 (Service Unavailable) quando a base de dados
 * ou conexões essenciais estiverem indisponíveis.
 */
class HealthController {
  /**
   * Sonda leve de vivacidade (Liveness Probe).
   * Confirma que a aplicação Express e o processo Node.js estão em execução.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  getLiveness(req, res) {
    const liveness = healthService.getLiveness();
    return res.status(200).json(liveness);
  }

  /**
   * Sonda de prontidão operacional (Readiness Probe).
   * Avalia a conectividade com a base de dados Neon PostgreSQL antes de rotear tráfego.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getReadiness(req, res, next) {
    try {
      const readiness = await healthService.getReadiness();
      const statusCode = readiness.status === 'healthy' ? 200 : 503;

      return res.status(statusCode).json(readiness);
    } catch (error) {
      return res.status(503).json({
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Diagnóstico detalhado de integridade para a esteira administrativa.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getDiagnostics(req, res, next) {
    try {
      const diagnostics = await healthService.getDetailedDiagnostics();
      const statusCode = diagnostics.status === 'healthy' ? 200 : 503;

      return res.status(statusCode).json({
        success: diagnostics.status === 'healthy',
        data: diagnostics
      });
    } catch (error) {
      return next(error);
    }
  }
}

// Instância singleton do controlador com vinculação de contexto
const healthController = new HealthController();
healthController.getLiveness = healthController.getLiveness.bind(healthController);
healthController.getReadiness = healthController.getReadiness.bind(healthController);
healthController.getDiagnostics = healthController.getDiagnostics.bind(healthController);

module.exports = healthController;