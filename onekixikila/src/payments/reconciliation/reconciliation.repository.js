const { query, queryOne } = require('../../database/query');

/**
 * Repositório de persistência para lotes de conciliação financeira e transações do livro-razão.
 */
class ReconciliationRepository {
  /**
   * Consulta as transações internas registadas para um prestador em determinado intervalo temporal.
   *
   * @param {string} provider - 'MULTICAIXA_EXPRESS', 'UNITEL_MONEY', 'E_KWANZA'
   * @param {Date} periodStart
   * @param {Date} periodEnd
   * @returns {Promise<Array<{
   *   merchant_reference: string,
   *   provider_transaction_id: string,
   *   amount: number,
   *   currency: string,
   *   status: string,
   *   created_at: Date,
   *   paid_at?: Date
   * }>>}
   */
  async getInternalTransactions(provider, periodStart, periodEnd) {
    const text = `
      SELECT 
        merchant_reference,
        provider_transaction_id,
        amount,
        currency,
        status,
        created_at,
        paid_at
      FROM payment_requests
      WHERE provider = UPPER($1)
        AND created_at >= $2
        AND created_at <= $3
      ORDER BY created_at ASC;
    `;

    const result = await query(text, [provider, periodStart, periodEnd]);
    return result.rows;
  }

  /**
   * Cria o registo analítico do lote de conciliação na tabela payment_reconciliations.
   *
   * @param {object} params
   * @returns {Promise<{ id: string, batch_reference: string, status: string }>}
   */
  async createReconciliationRecord(params) {
    const text = `
      INSERT INTO payment_reconciliations (
        batch_reference,
        provider,
        period_start,
        period_end,
        total_expected_records,
        total_matched_records,
        total_discrepancy_records,
        total_amount_internal,
        total_amount_external,
        currency,
        status,
        reconciled_by,
        reconciled_at,
        report_metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW() AT TIME ZONE 'UTC', $13)
      RETURNING id, batch_reference, status;
    `;

    const values = [
      params.batchReference,
      params.provider.toUpperCase(),
      params.periodStart,
      params.periodEnd,
      params.totalExpectedRecords,
      params.totalMatchedRecords,
      params.totalDiscrepancyRecords,
      params.totalAmountInternal,
      params.totalAmountExternal,
      params.currency || 'AOA',
      params.status,
      params.reconciledBy || null,
      JSON.stringify(params.reportMetadata || {})
    ];

    return queryOne(text, values);
  }

  /**
   * Localiza um lote de conciliação pela sua referência única.
   *
   * @param {string} batchReference
   */
  async findReconciliationByReference(batchReference) {
    const text = `
      SELECT 
        id,
        batch_reference,
        provider,
        period_start,
        period_end,
        total_expected_records,
        total_matched_records,
        total_discrepancy_records,
        total_amount_internal,
        total_amount_external,
        currency,
        status,
        reconciled_by,
        reconciled_at,
        report_metadata,
        created_at,
        updated_at
      FROM payment_reconciliations
      WHERE batch_reference = $1;
    `;
    return queryOne(text, [batchReference]);
  }

  /**
   * Atualiza um lote de conciliação marcando-o como resolvido manualmente por um auditor.
   *
   * @param {object} params
   * @param {string} params.batchReference
   * @param {string} params.resolvedBy - UUID do auditor
   * @param {string} params.resolutionNotes - Parecer técnico
   */
  async markManuallyResolved({ batchReference, resolvedBy, resolutionNotes }) {
    const text = `
      UPDATE payment_reconciliations
      SET status = 'MANUALLY_RESOLVED',
          reconciled_by = $1,
          reconciled_at = NOW() AT TIME ZONE 'UTC',
          report_metadata = jsonb_set(
            report_metadata,
            '{resolution}',
            $2::jsonb,
            true
          ),
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE batch_reference = $3
      RETURNING id, batch_reference, status;
    `;

    const resolutionData = JSON.stringify({
      notes: resolutionNotes,
      resolvedAt: new Date().toISOString(),
      resolvedBy
    });

    return queryOne(text, [resolvedBy, resolutionData, batchReference]);
  }

  /**
   * Lista os lotes de conciliação executados com paginação.
   *
   * @param {object} [options]
   * @param {number} [options.limit=20]
   * @param {number} [options.offset=0]
   */
  async listReconciliations(options = {}) {
    const { limit = 20, offset = 0 } = options;

    const text = `
      SELECT 
        id,
        batch_reference,
        provider,
        period_start,
        period_end,
        total_expected_records,
        total_matched_records,
        total_discrepancy_records,
        status,
        reconciled_at,
        created_at
      FROM payment_reconciliations
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2;
    `;

    const result = await query(text, [limit, offset]);
    return result.rows;
  }
}

// Instância singleton do repositório
const reconciliationRepository = new ReconciliationRepository();

module.exports = reconciliationRepository;