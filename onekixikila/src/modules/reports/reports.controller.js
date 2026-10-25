const reportsService = require('./reports.service');

/**
 * Controlador de adaptação HTTP para o módulo de Relatórios Analíticos e Indicadores Gerenciais.
 * Intermedeia requisições HTTP REST para entrega de métricas financeiras consolidadas,
 * séries temporais de circulação monetária, adimplência de quotas de grupos de Kixikila,
 * conformidade cadastral KYC, eficiência de gateways de pagamento e estatísticas de disputas/risco.
 */
class ReportsController {
  /**
   * Consulta o relatório consolidado de volumes financeiros por período.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getFinancialVolumeReport(req, res, next) {
    try {
      const { startDate, endDate } = req.query;
      const report = await reportsService.getFinancialVolumeReport(req.user, {
        startDate,
        endDate
      });

      return res.status(200).json({
        success: true,
        data: report
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta a série temporal diária de movimentações financeiras para gráficos executivos.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getFinancialTimeline(req, res, next) {
    try {
      const { startDate, endDate } = req.query;
      const timeline = await reportsService.getFinancialTimeline(req.user, {
        startDate,
        endDate
      });

      return res.status(200).json({
        success: true,
        data: {
          timeline
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta o relatório de adimplência e pontualidade de quotas de Kixikila (global ou por grupo).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getGroupComplianceReport(req, res, next) {
    try {
      const groupId = req.params.groupId || req.query.groupId || null;
      const report = await reportsService.getGroupComplianceReport(req.user, groupId);

      return res.status(200).json({
        success: true,
        data: report
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta o relatório da esteira de verificação de identidade e distribuição de níveis KYC.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getKycComplianceReport(req, res, next) {
    try {
      const report = await reportsService.getKycComplianceReport(req.user);

      return res.status(200).json({
        success: true,
        data: {
          kyc: report
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta o relatório de eficiência e taxas de conversão dos prestadores de pagamento integrados.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getProvidersPerformanceReport(req, res, next) {
    try {
      const providers = await reportsService.getProvidersPerformanceReport(req.user);

      return res.status(200).json({
        success: true,
        data: {
          providers
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta o relatório de deliberações de disputas e incidência de alertas de risco.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getDisputesAndRiskReport(req, res, next) {
    try {
      const report = await reportsService.getDisputesAndRiskReport(req.user);

      return res.status(200).json({
        success: true,
        data: report
      });
    } catch (error) {
      return next(error);
    }
  }
}

// Instância singleton do controlador com vinculação de contexto
const reportsController = new ReportsController();
reportsController.getFinancialVolumeReport = reportsController.getFinancialVolumeReport.bind(reportsController);
reportsController.getFinancialTimeline = reportsController.getFinancialTimeline.bind(reportsController);
reportsController.getGroupComplianceReport = reportsController.getGroupComplianceReport.bind(reportsController);
reportsController.getKycComplianceReport = reportsController.getKycComplianceReport.bind(reportsController);
reportsController.getProvidersPerformanceReport = reportsController.getProvidersPerformanceReport.bind(reportsController);
reportsController.getDisputesAndRiskReport = reportsController.getDisputesAndRiskReport.bind(reportsController);

module.exports = reportsController;