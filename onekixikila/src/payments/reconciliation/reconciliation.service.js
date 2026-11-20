const crypto = require('crypto');
const providerFactory = require('../providers/provider-factory');
const reconciliationRepository = require('./reconciliation.repository');
const {
  DISCREPANCY_TYPES,
  ReconciliationResultDTO
} = require('../contracts/reconciliation.contract');
const paymentsConfig = require('../../config/payments');

/**
 * Serviço de conciliação financeira entre a plataforma OneKixikila e os gateways angolanos.
 * Identifica discrepâncias de montantes, estados e transações órfãs entre o livro-razão e os extratos externos.
 */
class ReconciliationService {
  /**
   * Executa a reconciliação de transações para determinado prestador e intervalo de datas.
   *
   * @param {object} params
   * @param {string} params.provider - 'MULTICAIXA_EXPRESS', 'UNITEL_MONEY' ou 'E_KWANZA'
   * @param {Date} params.periodStart
   * @param {Date} params.periodEnd
   * @param {string} [params.reconciledBy] - UUID do auditor/operador administrativo (opcional)
   * @returns {Promise<ReconciliationResultDTO>}
   */
  async reconcilePeriod({ provider, periodStart, periodEnd, reconciledBy = null }) {
    const batchReference = `REC-${provider.slice(0, 3).toUpperCase()}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const adapter = providerFactory.getProvider(provider);

    // 1. Obtém os registos externos reportados pelo prestador
    let externalRecords = [];
    try {
      externalRecords = await adapter.fetchReconciliationBatch(periodStart, periodEnd);
    } catch (fetchError) {
      console.error(`[RECONCILIATION:FETCH_ERROR] Erro ao extrair lote externo de [${provider}]:`, fetchError.message);
      throw new Error(`Falha ao obter extrato do prestador [${provider}]: ${fetchError.message}`);
    }

    // 2. Consulta os registos internos correspondentes na base de dados
    const internalRecords = await reconciliationRepository.getInternalTransactions(
      provider,
      periodStart,
      periodEnd
    );

    // 3. Mapeamento por chave de referência
    const internalMap = new Map();
    for (const record of internalRecords) {
      internalMap.set(record.merchant_reference, record);
    }

    const externalMap = new Map();
    for (const record of externalRecords) {
      externalMap.set(record.merchantReference, record);
    }

    const discrepancies = [];
    let totalMatched = 0;
    let totalInternalAmount = 0;
    let totalExternalAmount = 0;

    // 4. Cruzamento dos registos internos contra o extrato bancário
    for (const internal of internalRecords) {
      totalInternalAmount += Number(internal.amount);
      const external = externalMap.get(internal.merchant_reference);

      if (!external) {
        discrepancies.push({
          type: DISCREPANCY_TYPES.MISSING_IN_EXTERNAL,
          merchantReference: internal.merchant_reference,
          providerTransactionId: internal.provider_transaction_id,
          internalAmount: Number(internal.amount),
          internalStatus: internal.status,
          details: 'Transação confirmada internamente mas ausente no relatório do prestador.'
        });
        continue;
      }

      // Validação de paridade de valor em Kwanzas
      const amountMatches = Number(internal.amount) === Number(external.amount);
      // Validação de estado
      const statusMatches =
        (internal.status === 'SUCCEEDED' && external.status === 'SETTLED') ||
        (internal.status === 'FAILED' && external.status === 'FAILED');

      if (!amountMatches) {
        discrepancies.push({
          type: DISCREPANCY_TYPES.AMOUNT_MISMATCH,
          merchantReference: internal.merchant_reference,
          providerTransactionId: external.providerTransactionId,
          internalAmount: Number(internal.amount),
          externalAmount: Number(external.amount),
          details: `Divergência de montante: Interno [${internal.amount} Kz] vs Externo [${external.amount} Kz].`
        });
      } else if (!statusMatches) {
        discrepancies.push({
          type: DISCREPANCY_TYPES.STATUS_MISMATCH,
          merchantReference: internal.merchant_reference,
          providerTransactionId: external.providerTransactionId,
          internalStatus: internal.status,
          externalStatus: external.status,
          details: `Divergência de estado: Interno [${internal.status}] vs Externo [${external.status}].`
        });
      } else {
        totalMatched += 1;
      }
    }

    // 5. Cruzamento reverso: deteção de créditos órfãos presentes no banco mas inexistentes no sistema
    for (const external of externalRecords) {
      totalExternalAmount += Number(external.amount);
      if (!internalMap.has(external.merchantReference)) {
        discrepancies.push({
          type: DISCREPANCY_TYPES.MISSING_IN_INTERNAL,
          merchantReference: external.merchantReference,
          providerTransactionId: external.providerTransactionId,
          externalAmount: Number(external.amount),
          externalStatus: external.status,
          details: 'Transação creditada na rede bancária sem registo prévio correspondente no OneKixikila.'
        });
      }
    }

    // 6. Determinação do estado final do lote
    let finalStatus = 'MATCHED';
    if (discrepancies.length > 0) {
      const hasAmountDiscrepancy = discrepancies.some(
        (d) => d.type === DISCREPANCY_TYPES.AMOUNT_MISMATCH || d.type === DISCREPANCY_TYPES.MISSING_IN_EXTERNAL || d.type === DISCREPANCY_TYPES.MISSING_IN_INTERNAL
      );
      finalStatus = hasAmountDiscrepancy ? 'DISCREPANCY_AMOUNT' : 'DISCREPANCY_STATUS';
    }

    const totalExpected = Math.max(internalRecords.length, externalRecords.length);

    const result = new ReconciliationResultDTO({
      batchReference,
      provider,
      status: finalStatus,
      totalExpectedRecords: totalExpected,
      totalMatchedRecords: totalMatched,
      totalDiscrepancyRecords: discrepancies.length,
      totalAmountInternal,
      totalAmountExternal,
      discrepancies
    });

    // 7. Persistência do resultado na tabela payment_reconciliations
    await reconciliationRepository.createReconciliationRecord({
      batchReference,
      provider,
      periodStart,
      periodEnd,
      totalExpectedRecords: totalExpected,
      totalMatchedRecords: totalMatched,
      totalDiscrepancyRecords: discrepancies.length,
      totalAmountInternal,
      totalAmountExternal,
      currency: 'AOA',
      status: finalStatus,
      reconciledBy,
      reportMetadata: {
        discrepancies,
        generatedAt: new Date().toISOString()
      }
    });

    return result;
  }

  /**
   * Marca uma conciliação com discrepâncias como resolvida manualmente após intervenção de auditor.
   *
   * @param {object} params
   * @param {string} params.batchReference
   * @param {string} params.resolvedBy - UUID do auditor responsável
   * @param {string} params.resolutionNotes - Justificativa técnica
   */
  async resolveDiscrepancyManually({ batchReference, resolvedBy, resolutionNotes }) {
    return reconciliationRepository.markManuallyResolved({
      batchReference,
      resolvedBy,
      resolutionNotes
    });
  }
}

// Instância singleton do serviço
const reconciliationService = new ReconciliationService();

module.exports = reconciliationService;