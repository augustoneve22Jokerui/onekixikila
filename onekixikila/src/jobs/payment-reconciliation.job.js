const { query } = require('../database/query');
const reconciliationService = require('../payments/reconciliation/reconciliation.service');
const providerFactory = require('../payments/providers/provider-factory');
const paymentsConfig = require('../config/payments');

/**
 * Tarefa agendada para reconciliação contábil periódica entre o livro-razão interno
 * e os relatórios dos prestadores de pagamento em Angola (Multicaixa Express, Unitel Money e e-Kwanza),
 * além da expiração de intenções de pagamento abandonadas.
 */
class PaymentReconciliationJob {
  /**
   * Executa a rotina periódica de conciliação e limpeza de pagamentos órfãos.
   *
   * @returns {Promise<{
   *   reconciledProviders: string[],
   *   expiredPendingPayments: number,
   *   results: object[]
   * }>}
   */
  async run() {
    const results = [];
    const reconciledProviders = [];

    // 1. Expiração automática de intenções de pagamento pendentes e abandonadas
    let expiredPendingPayments = 0;
    if (paymentsConfig.reconciliation.autoExpireAbandonedPayments) {
      const expireQuery = `
        WITH expired_payments AS (
          UPDATE payment_requests
          SET status = 'EXPIRED',
              updated_at = NOW() AT TIME ZONE 'UTC'
          WHERE status = 'PENDING'
            AND expires_at < (NOW() AT TIME ZONE 'UTC')
          RETURNING id, deposit_id
        )
        UPDATE deposits
        SET status = 'EXPIRED',
            updated_at = NOW() AT TIME ZONE 'UTC'
        WHERE id IN (
          SELECT deposit_id FROM expired_payments WHERE deposit_id IS NOT NULL
        )
        AND status = 'PENDING_PAYMENT';
      `;
      const expireResult = await query(expireQuery);
      expiredPendingPayments = expireResult.rowCount || 0;
    }

    // 2. Determina o intervalo de conciliação (últimas 24 horas até ao momento presente)
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000);

    // 3. Executa a conciliação analítica para cada prestador habilitado
    const availableProviders = providerFactory.listAvailableProviders();

    for (const provider of availableProviders) {
      if (!provider.enabled) {
        continue;
      }

      try {
        console.log(`[JOB:RECONCILIATION] Iniciando cruzamento contábil para [${provider.id}]...`);
        const result = await reconciliationService.reconcilePeriod({
          provider: provider.id.toUpperCase(),
          periodStart,
          periodEnd,
          reconciledBy: null // Execução automatizada de sistema
        });

        results.push({
          provider: provider.id,
          batchReference: result.batchReference,
          status: result.status,
          totalMatched: result.totalMatchedRecords,
          totalDiscrepancies: result.totalDiscrepancyRecords
        });

        reconciledProviders.push(provider.id);
      } catch (provError) {
        console.error(`[JOB:RECONCILIATION:WARN] Falha na conciliação de [${provider.id}]:`, provError.message);
        results.push({
          provider: provider.id,
          status: 'SKIPPED_OR_FAILED',
          error: provError.message
        });
      }
    }

    return {
      reconciledProviders,
      expiredPendingPayments,
      results
    };
  }
}

// Instância singleton do job
const paymentReconciliationJob = new PaymentReconciliationJob();

module.exports = paymentReconciliationJob;