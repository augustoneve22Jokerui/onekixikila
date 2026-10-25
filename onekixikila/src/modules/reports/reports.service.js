const reportsRepository = require('./reports.repository');
const adminPolicy = require('../admin/admin.policy');
const groupsRepository = require('../groups/groups.repository');
const membershipsRepository = require('../memberships/memberships.repository');
const Money = require('../../shared/finance/money');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço de regras de negócio para Geração de Relatórios Analíticos,
 * Indicadores Financeiros e Auditoria de Desempenho na plataforma OneKixikila.
 */
class ReportsService {
  /**
   * Obtém o relatório financeiro consolidado de volumes movimentados em determinado período.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} [dateRange={}] - { startDate, endDate }
   * @returns {Promise<object>}
   */
  async getFinancialVolumeReport(actingUser, dateRange = {}) {
    const accessCheck = adminPolicy.canAccessAdminPanel(actingUser);
    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    const { startDate, endDate } = this.resolveDateRange(dateRange.startDate, dateRange.endDate);

    const report = await reportsRepository.getFinancialVolumeReport({ startDate, endDate });

    return {
      period: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString()
      },
      metrics: {
        deposits: {
          volume: Number(report.depositsVolume),
          formattedVolume: Money.of(report.depositsVolume, 'AOA').format(),
          count: report.depositsCount
        },
        withdrawals: {
          volume: Number(report.withdrawalsVolume),
          formattedVolume: Money.of(report.withdrawalsVolume, 'AOA').format(),
          count: report.withdrawalsCount
        },
        transfers: {
          volume: Number(report.transfersVolume),
          formattedVolume: Money.of(report.transfersVolume, 'AOA').format(),
          count: report.transfersCount
        },
        contributions: {
          volume: Number(report.contributionsVolume),
          formattedVolume: Money.of(report.contributionsVolume, 'AOA').format(),
          count: report.contributionsCount
        },
        payouts: {
          volume: Number(report.payoutsVolume),
          formattedVolume: Money.of(report.payoutsVolume, 'AOA').format(),
          count: report.payoutsCount
        },
        feesCollected: {
          volume: Number(report.feesCollected),
          formattedVolume: Money.of(report.feesCollected, 'AOA').format()
        }
      }
    };
  }

  /**
   * Obtém a série temporal diária para alimentar gráficos de depósitos vs desembolsos.
   *
   * @param {object} actingUser
   * @param {object} [dateRange={}]
   * @returns {Promise<Array<object>>}
   */
  async getFinancialTimeline(actingUser, dateRange = {}) {
    const accessCheck = adminPolicy.canAccessAdminPanel(actingUser);
    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    const { startDate, endDate } = this.resolveDateRange(dateRange.startDate, dateRange.endDate, 30);

    const timeline = await reportsRepository.getDailyFinancialTimeline({ startDate, endDate });

    return timeline.map((entry) => ({
      date: entry.date,
      deposits: Number(entry.deposits),
      payouts: Number(entry.payouts),
      formattedDeposits: Money.of(entry.deposits, 'AOA').format(),
      formattedPayouts: Money.of(entry.payouts, 'AOA').format()
    }));
  }

  /**
   * Obtém o relatório analítico de adimplência de quotas de determinado grupo ou global.
   *
   * @param {object} actingUser
   * @param {string|null} [groupId=null]
   * @returns {Promise<object>}
   */
  async getGroupComplianceReport(actingUser, groupId = null) {
    if (groupId) {
      const group = await groupsRepository.findById(groupId);
      if (!group) {
        throw NotFoundError.group(groupId);
      }

      const isLeader = group.leader_id === actingUser.id || group.creator_id === actingUser.id;
      const isAdmin = actingUser.role === 'ADMIN' || actingUser.role === 'AUDITOR';

      if (!isLeader && !isAdmin) {
        const membership = await membershipsRepository.findByGroupAndUser(groupId, actingUser.id);
        if (!membership || membership.status !== 'ACTIVE') {
          throw new AuthorizationError('Acesso restrito aos participantes deste grupo.');
        }
      }

      const stats = await reportsRepository.getGroupComplianceReport(groupId);
      return {
        groupId,
        groupName: group.name,
        compliance: stats
      };
    }

    // Relatório global de adimplência de todos os grupos da plataforma (Admin/Auditor)
    const accessCheck = adminPolicy.canAccessAdminPanel(actingUser);
    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    const globalStats = await reportsRepository.getGroupComplianceReport(null);
    return {
      scope: 'GLOBAL',
      compliance: globalStats
    };
  }

  /**
   * Obtém o relatório de conformidade cadastral e distribuição de níveis KYC.
   *
   * @param {object} actingUser
   * @returns {Promise<object>}
   */
  async getKycComplianceReport(actingUser) {
    const accessCheck = adminPolicy.canAccessAdminPanel(actingUser);
    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    return reportsRepository.getKycComplianceReport();
  }

  /**
   * Obtém o relatório de desempenho e taxas de sucesso por prestador de pagamento.
   *
   * @param {object} actingUser
   * @returns {Promise<Array<object>>}
   */
  async getProvidersPerformanceReport(actingUser) {
    const accessCheck = adminPolicy.canManageFinancialOperations(actingUser);
    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    const rows = await reportsRepository.getProvidersPerformanceReport();

    return rows.map((r) => ({
      provider: r.provider,
      totalRequests: r.totalRequests,
      succeededCount: r.succeededCount,
      failedCount: r.failedCount,
      totalVolume: Number(r.totalVolume),
      formattedVolume: Money.of(r.totalVolume, 'AOA').format(),
      successRatePercentage: r.successRatePercentage
    }));
  }

  /**
   * Obtém o relatório analítico de disputas e distribuição de eventos de risco.
   *
   * @param {object} actingUser
   * @returns {Promise<object>}
   */
  async getDisputesAndRiskReport(actingUser) {
    const accessCheck = adminPolicy.canAccessAdminPanel(actingUser);
    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    return reportsRepository.getDisputesAndRiskReport();
  }

  /**
   * Normaliza e valida um intervalo de datas para geração de relatórios.
   *
   * @param {string|Date} [startInput]
   * @param {string|Date} [endInput]
   * @param {number} [defaultDaysBack=30]
   * @returns {{ startDate: Date, endDate: Date }}
   * @private
   */
  resolveDateRange(startInput, endInput, defaultDaysBack = 30) {
    const endDate = endInput ? new Date(endInput) : new Date();
    endDate.setUTCHours(23, 59, 59, 999);

    let startDate;
    if (startInput) {
      startDate = new Date(startInput);
      startDate.setUTCHours(0, 0, 0, 0);
    } else {
      startDate = new Date(endDate.getTime() - defaultDaysBack * 24 * 60 * 60 * 1000);
      startDate.setUTCHours(0, 0, 0, 0);
    }

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      throw new ValidationError('Intervalo de datas inválido fornecido para o relatório.');
    }

    if (startDate > endDate) {
      throw new ValidationError('A data inicial não pode ser superior à data final do relatório.');
    }

    return { startDate, endDate };
  }
}

// Instância singleton do serviço de relatórios
const reportsService = new ReportsService();

module.exports = reportsService;