const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para geração de relatórios analíticos, agregados financeiros,
 * desempenho de grupos de Kixikila, conformidade regulatória KYC e eficiência de prestadores de pagamento.
 * Executa consultas diretas e agregadas no Neon PostgreSQL com precisão matemática em Kwanzas (AOA).
 */
class ReportsRepository {
  /**
   * Obtém o relatório analítico consolidado de movimentações financeiras por intervalo de datas.
   *
   * @param {object} params
   * @param {Date} params.startDate
   * @param {Date} params.endDate
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<{
   *   depositsVolume: bigint,
   *   depositsCount: number,
   *   withdrawalsVolume: bigint,
   *   withdrawalsCount: number,
   *   transfersVolume: bigint,
   *   transfersCount: number,
   *   contributionsVolume: bigint,
   *   contributionsCount: number,
   *   payoutsVolume: bigint,
   *   payoutsCount: number,
   *   feesCollected: bigint
   * }>}
   */
  async getFinancialVolumeReport(params, client = null) {
    const { startDate, endDate } = params;

    const text = `
      SELECT 
        -- Depósitos confirmados
        (
          SELECT COALESCE(SUM(amount), 0)::bigint 
          FROM deposits 
          WHERE status IN ('CONFIRMED', 'SETTLED') AND created_at >= $1 AND created_at <= $2
        ) AS deposits_volume,
        (
          SELECT COUNT(*)::integer 
          FROM deposits 
          WHERE status IN ('CONFIRMED', 'SETTLED') AND created_at >= $1 AND created_at <= $2
        ) AS deposits_count,

        -- Levantamentos liquidados
        (
          SELECT COALESCE(SUM(amount), 0)::bigint 
          FROM withdrawals 
          WHERE status = 'SETTLED' AND created_at >= $1 AND created_at <= $2
        ) AS withdrawals_volume,
        (
          SELECT COUNT(*)::integer 
          FROM withdrawals 
          WHERE status = 'SETTLED' AND created_at >= $1 AND created_at <= $2
        ) AS withdrawals_count,

        -- Transferências internas concluídas
        (
          SELECT COALESCE(SUM(amount), 0)::bigint 
          FROM internal_transfers 
          WHERE status = 'COMPLETED' AND created_at >= $1 AND created_at <= $2
        ) AS transfers_volume,
        (
          SELECT COUNT(*)::integer 
          FROM internal_transfers 
          WHERE status = 'COMPLETED' AND created_at >= $1 AND created_at <= $2
        ) AS transfers_count,

        -- Quotas arrecadadas de Kixikila
        (
          SELECT COALESCE(SUM(amount), 0)::bigint 
          FROM contributions 
          WHERE status = 'CONFIRMED' AND created_at >= $1 AND created_at <= $2
        ) AS contributions_volume,
        (
          SELECT COUNT(*)::integer 
          FROM contributions 
          WHERE status = 'CONFIRMED' AND created_at >= $1 AND created_at <= $2
        ) AS contributions_count,

        -- Desembolsos de bolo pagos
        (
          SELECT COALESCE(SUM(actual_disbursed_amount), 0)::bigint 
          FROM rotation_schedules 
          WHERE status = 'PAID_OUT' AND actual_payout_date >= $1 AND actual_payout_date <= $2
        ) AS payouts_volume,
        (
          SELECT COUNT(*)::integer 
          FROM rotation_schedules 
          WHERE status = 'PAID_OUT' AND actual_payout_date >= $1 AND actual_payout_date <= $2
        ) AS payouts_count,

        -- Tarifas arrecadadas
        (
          SELECT COALESCE(SUM(fee_amount), 0)::bigint 
          FROM (
            SELECT fee_amount FROM deposits WHERE status IN ('CONFIRMED', 'SETTLED') AND created_at >= $1 AND created_at <= $2
            UNION ALL
            SELECT fee_amount FROM withdrawals WHERE status = 'SETTLED' AND created_at >= $1 AND created_at <= $2
            UNION ALL
            SELECT fee_amount FROM internal_transfers WHERE status = 'COMPLETED' AND created_at >= $1 AND created_at <= $2
            UNION ALL
            SELECT fee_amount FROM contributions WHERE status = 'CONFIRMED' AND created_at >= $1 AND created_at <= $2
          ) f
        ) AS fees_collected;
    `;

    const result = client ? await queryOneClient(client, text, [startDate, endDate]) : await queryOne(text, [startDate, endDate]);

    return {
      depositsVolume: result ? BigInt(result.deposits_volume) : 0n,
      depositsCount: result ? Number(result.deposits_count) : 0,
      withdrawalsVolume: result ? BigInt(result.withdrawals_volume) : 0n,
      withdrawalsCount: result ? Number(result.withdrawals_count) : 0,
      transfersVolume: result ? BigInt(result.transfers_volume) : 0n,
      transfersCount: result ? Number(result.transfers_count) : 0,
      contributionsVolume: result ? BigInt(result.contributions_volume) : 0n,
      contributionsCount: result ? Number(result.contributions_count) : 0,
      payoutsVolume: result ? BigInt(result.payouts_volume) : 0n,
      payoutsCount: result ? Number(result.payouts_count) : 0,
      feesCollected: result ? BigInt(result.fees_collected) : 0n
    };
  }

  /**
   * Consulta a série temporal diária de depósitos e desembolsos para gráficos gerenciais.
   *
   * @param {object} params
   * @param {Date} params.startDate
   * @param {Date} params.endDate
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<Array<{ date: string, deposits: bigint, payouts: bigint }>>}
   */
  async getDailyFinancialTimeline(params, client = null) {
    const { startDate, endDate } = params;

    const text = `
      WITH dates AS (
        SELECT generate_series($1::date, $2::date, '1 day'::interval)::date AS day
      ),
      daily_deposits AS (
        SELECT 
          date_trunc('day', created_at)::date AS day,
          COALESCE(SUM(amount), 0)::bigint AS amount
        FROM deposits
        WHERE status IN ('CONFIRMED', 'SETTLED') AND created_at >= $1 AND created_at <= $2
        GROUP BY 1
      ),
      daily_payouts AS (
        SELECT 
          date_trunc('day', actual_payout_date)::date AS day,
          COALESCE(SUM(actual_disbursed_amount), 0)::bigint AS amount
        FROM rotation_schedules
        WHERE status = 'PAID_OUT' AND actual_payout_date >= $1 AND actual_payout_date <= $2
        GROUP BY 1
      )
      SELECT 
        to_char(d.day, 'YYYY-MM-DD') AS date,
        COALESCE(dd.amount, 0)::bigint AS deposits,
        COALESCE(dp.amount, 0)::bigint AS payouts
      FROM dates d
      LEFT JOIN daily_deposits dd ON dd.day = d.day
      LEFT JOIN daily_payouts dp ON dp.day = d.day
      ORDER BY d.day ASC;
    `;

    const result = client ? await queryClient(client, text, [startDate, endDate]) : await query(text, [startDate, endDate]);
    return result.rows.map((r) => ({
      date: r.date,
      deposits: BigInt(r.deposits),
      payouts: BigInt(r.payouts)
    }));
  }

  /**
   * Obtém o relatório analítico de adimplência de quotas nos Grupos de Kixikila.
   *
   * @param {string|null} [groupId=null] - Opcional para filtrar por grupo individual
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<{
   *   totalObligations: number,
   *   paidOnTime: number,
   *   paidLate: number,
   *   currentlyLate: number,
   *   defaulted: number,
   *   onTimeRatePercentage: number
   * }>}
   */
  async getGroupComplianceReport(groupId = null, client = null) {
    const conditions = [];
    const values = [];

    if (groupId) {
      conditions.push('group_id = $1');
      values.push(groupId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const text = `
      SELECT 
        COUNT(*)::integer AS total_obligations,
        COALESCE(SUM(CASE WHEN status = 'PAID' AND (paid_at <= grace_date OR paid_at IS NULL) THEN 1 ELSE 0 END), 0)::integer AS paid_on_time,
        COALESCE(SUM(CASE WHEN status = 'PAID' AND paid_at > grace_date THEN 1 ELSE 0 END), 0)::integer AS paid_late,
        COALESCE(SUM(CASE WHEN status = 'LATE' THEN 1 ELSE 0 END), 0)::integer AS currently_late,
        COALESCE(SUM(CASE WHEN status = 'DEFAULTED' THEN 1 ELSE 0 END), 0)::integer AS defaulted
      FROM contribution_obligations
      ${whereClause};
    `;

    const result = client ? await queryOneClient(client, text, values) : await queryOne(text, values);

    const total = result ? Number(result.total_obligations) : 0;
    const paidOnTime = result ? Number(result.paid_on_time) : 0;
    const onTimeRate = total > 0 ? Number(((paidOnTime / total) * 100).toFixed(2)) : 100.0;

    return {
      totalObligations: total,
      paidOnTime,
      paidLate: result ? Number(result.paid_late) : 0,
      currentlyLate: result ? Number(result.currently_late) : 0,
      defaulted: result ? Number(result.defaulted) : 0,
      onTimeRatePercentage: onTimeRate
    };
  }

  /**
   * Obtém o relatório de conformidade e status da esteira de verificação cadastral KYC.
   *
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<{
   *   totalSubmissions: number,
   *   approvedCount: number,
   *   rejectedCount: number,
   *   underReviewCount: number,
   *   needsReviewCount: number,
   *   tierDistribution: object
   * }>}
   */
  async getKycComplianceReport(client = null) {
    const text = `
      SELECT 
        COUNT(*)::integer AS total_submissions,
        COALESCE(SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END), 0)::integer AS approved_count,
        COALESCE(SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END), 0)::integer AS rejected_count,
        COALESCE(SUM(CASE WHEN status = 'UNDER_REVIEW' THEN 1 ELSE 0 END), 0)::integer AS under_review_count,
        COALESCE(SUM(CASE WHEN status = 'NEEDS_REVIEW' THEN 1 ELSE 0 END), 0)::integer AS needs_review_count,
        COALESCE(SUM(CASE WHEN tier = 'TIER_1_UNVERIFIED' THEN 1 ELSE 0 END), 0)::integer AS tier1_count,
        COALESCE(SUM(CASE WHEN tier = 'TIER_2_VERIFIED' THEN 1 ELSE 0 END), 0)::integer AS tier2_count,
        COALESCE(SUM(CASE WHEN tier = 'TIER_3_ENHANCED' THEN 1 ELSE 0 END), 0)::integer AS tier3_count
      FROM identity_verifications;
    `;

    const result = client ? await queryOneClient(client, text) : await queryOne(text);

    return {
      totalSubmissions: result ? Number(result.total_submissions) : 0,
      approvedCount: result ? Number(result.approved_count) : 0,
      rejectedCount: result ? Number(result.rejected_count) : 0,
      underReviewCount: result ? Number(result.under_review_count) : 0,
      needsReviewCount: result ? Number(result.needs_review_count) : 0,
      tierDistribution: {
        tier1Unverified: result ? Number(result.tier1_count) : 0,
        tier2Verified: result ? Number(result.tier2_count) : 0,
        tier3Enhanced: result ? Number(result.tier3_count) : 0
      }
    };
  }

  /**
   * Obtém o relatório de eficiência e volumetria segregada por prestador de pagamento angolano.
   *
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<Array<{
   *   provider: string,
   *   totalRequests: number,
   *   succeededCount: number,
   *   failedCount: number,
   *   totalVolume: bigint,
   *   successRatePercentage: number
   * }>>}
   */
  async getProvidersPerformanceReport(client = null) {
    const text = `
      SELECT 
        provider,
        COUNT(*)::integer AS total_requests,
        COALESCE(SUM(CASE WHEN status = 'SUCCEEDED' THEN 1 ELSE 0 END), 0)::integer AS succeeded_count,
        COALESCE(SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0)::integer AS failed_count,
        COALESCE(SUM(CASE WHEN status = 'SUCCEEDED' THEN amount ELSE 0 END), 0)::bigint AS total_volume
      FROM payment_requests
      GROUP BY provider
      ORDER BY total_volume DESC;
    `;

    const result = client ? await queryClient(client, text) : await query(text);

    return result.rows.map((r) => {
      const total = Number(r.total_requests);
      const succeeded = Number(r.succeeded_count);
      const rate = total > 0 ? Number(((succeeded / total) * 100).toFixed(2)) : 0.0;

      return {
        provider: r.provider,
        totalRequests: total,
        succeededCount: succeeded,
        failedCount: Number(r.failed_count),
        totalVolume: BigInt(r.total_volume),
        successRatePercentage: rate
      };
    });
  }

  /**
   * Obtém o relatório de resoluções de disputas e distribuição por nível de risco.
   *
   * @param {import('pg').PoolClient} [client=null]
   * @returns {Promise<{
   *   totalDisputes: number,
   *   openDisputes: number,
   *   resolvedFavorInitiator: number,
   *   resolvedFavorRespondent: number,
   *   dismissed: number,
   *   riskEventsDistribution: object
   * }>}
   */
  async getDisputesAndRiskReport(client = null) {
    const disputesSql = `
      SELECT 
        COUNT(*)::integer AS total_disputes,
        COALESCE(SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END), 0)::integer AS open_disputes,
        COALESCE(SUM(CASE WHEN status = 'RESOLVED_FAVOR_INITIATOR' THEN 1 ELSE 0 END), 0)::integer AS resolved_initiator,
        COALESCE(SUM(CASE WHEN status = 'RESOLVED_FAVOR_RESPONDENT' THEN 1 ELSE 0 END), 0)::integer AS resolved_respondent,
        COALESCE(SUM(CASE WHEN status = 'CLOSED_DISMISSED' THEN 1 ELSE 0 END), 0)::integer AS dismissed
      FROM disputes;
    `;

    const riskSql = `
      SELECT 
        COALESCE(SUM(CASE WHEN risk_level = 'LOW' THEN 1 ELSE 0 END), 0)::integer AS low_count,
        COALESCE(SUM(CASE WHEN risk_level = 'MEDIUM' THEN 1 ELSE 0 END), 0)::integer AS medium_count,
        COALESCE(SUM(CASE WHEN risk_level = 'HIGH' THEN 1 ELSE 0 END), 0)::integer AS high_count,
        COALESCE(SUM(CASE WHEN risk_level = 'CRITICAL' THEN 1 ELSE 0 END), 0)::integer AS critical_count
      FROM risk_events;
    `;

    const disputesRes = client ? await queryOneClient(client, disputesSql) : await queryOne(disputesSql);
    const riskRes = client ? await queryOneClient(client, riskSql) : await queryOne(riskSql);

    return {
      totalDisputes: disputesRes ? Number(disputesRes.total_disputes) : 0,
      openDisputes: disputesRes ? Number(disputesRes.open_disputes) : 0,
      resolvedFavorInitiator: disputesRes ? Number(disputesRes.resolved_initiator) : 0,
      resolvedFavorRespondent: disputesRes ? Number(disputesRes.resolved_respondent) : 0,
      dismissed: disputesRes ? Number(disputesRes.dismissed) : 0,
      riskEventsDistribution: {
        low: riskRes ? Number(riskRes.low_count) : 0,
        medium: riskRes ? Number(riskRes.medium_count) : 0,
        high: riskRes ? Number(riskRes.high_count) : 0,
        critical: riskRes ? Number(riskRes.critical_count) : 0
      }
    };
  }
}

// Instância singleton do repositório de relatórios
const reportsRepository = new ReportsRepository();

module.exports = reportsRepository;