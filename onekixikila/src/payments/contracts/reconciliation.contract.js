const { z } = require('zod');

/**
 * Categorias de discrepâncias contábeis apuradas na conciliação financeira.
 */
const DISCREPANCY_TYPES = Object.freeze({
  MISSING_IN_EXTERNAL: 'MISSING_IN_EXTERNAL', // Registado internamente, mas ausente no extrato do gateway
  MISSING_IN_INTERNAL: 'MISSING_IN_INTERNAL', // Presente no gateway, mas sem registo no razão interno (órfão)
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',         // Divergência de valores entre o registo interno e bancário
  STATUS_MISMATCH: 'STATUS_MISMATCH'          // Estado interno difere do estado final no prestador
});

// Schema de validação para um registo financeiro individual a conciliar
const reconciliationRecordSchema = z.object({
  merchantReference: z.string().min(1, 'merchantReference é obrigatório.'),
  providerTransactionId: z.string().min(1, 'providerTransactionId é obrigatório.'),
  amount: z.number().int().positive('Montante deve ser um número inteiro de Kwanzas superior a zero.'),
  currency: z.string().length(3).default('AOA'),
  status: z.string().min(1, 'Status é obrigatório.'),
  settledAt: z.date()
});

// Schema de validação para a solicitação de conciliação em lote
const reconciliationBatchSchema = z.object({
  provider: z.enum(['MULTICAIXA_EXPRESS', 'UNITEL_MONEY', 'E_KWANZA']),
  batchReference: z.string().min(6).max(64),
  periodStart: z.date(),
  periodEnd: z.date(),
  records: z.array(reconciliationRecordSchema).default([])
});

/**
 * Objeto de Transferência de Dados (DTO) para o lote de conciliação externa.
 */
class ReconciliationBatchDTO {
  /**
   * @param {object} rawData
   */
  constructor(rawData) {
    const validated = reconciliationBatchSchema.parse(rawData);

    this.provider = validated.provider;
    this.batchReference = validated.batchReference;
    this.periodStart = validated.periodStart;
    this.periodEnd = validated.periodEnd;
    this.records = Object.freeze(validated.records.map((r) => Object.freeze({ ...r })));

    Object.freeze(this);
  }

  static from(rawData) {
    return new ReconciliationBatchDTO(rawData);
  }
}

/**
 * Objeto de Transferência de Dados (DTO) para o resultado apurado da conciliação contábil.
 */
class ReconciliationResultDTO {
  /**
   * @param {object} params
   * @param {string} params.batchReference
   * @param {string} params.provider
   * @param {'MATCHED'|'DISCREPANCY_AMOUNT'|'DISCREPANCY_STATUS'} params.status
   * @param {number} params.totalExpectedRecords
   * @param {number} params.totalMatchedRecords
   * @param {number} params.totalDiscrepancyRecords
   * @param {number} params.totalAmountInternal
   * @param {number} params.totalAmountExternal
   * @param {Array<{
   *   type: string,
   *   merchantReference: string,
   *   providerTransactionId?: string,
   *   internalAmount?: number,
   *   externalAmount?: number,
   *   internalStatus?: string,
   *   externalStatus?: string,
   *   details: string
   * }>} params.discrepancies
   */
  constructor(params) {
    this.batchReference = params.batchReference;
    this.provider = params.provider;
    this.status = params.status;
    this.totalExpectedRecords = params.totalExpectedRecords;
    this.totalMatchedRecords = params.totalMatchedRecords;
    this.totalDiscrepancyRecords = params.totalDiscrepancyRecords;
    this.totalAmountInternal = params.totalAmountInternal;
    this.totalAmountExternal = params.totalAmountExternal;
    this.discrepancies = Object.freeze([...(params.discrepancies || [])]);
    this.reconciledAt = new Date();

    Object.freeze(this);
  }

  toJSON() {
    return {
      batchReference: this.batchReference,
      provider: this.provider,
      status: this.status,
      totalExpectedRecords: this.totalExpectedRecords,
      totalMatchedRecords: this.totalMatchedRecords,
      totalDiscrepancyRecords: this.totalDiscrepancyRecords,
      totalAmountInternal: this.totalAmountInternal,
      totalAmountExternal: this.totalAmountExternal,
      discrepancies: this.discrepancies,
      reconciledAt: this.reconciledAt.toISOString()
    };
  }
}

module.exports = {
  DISCREPANCY_TYPES,
  reconciliationRecordSchema,
  reconciliationBatchSchema,
  ReconciliationBatchDTO,
  ReconciliationResultDTO
};