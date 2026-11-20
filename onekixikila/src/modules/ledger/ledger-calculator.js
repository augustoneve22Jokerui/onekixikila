const ValidationError = require('../../shared/errors/validation-error');

/**
 * Calculadora pura de lançamentos contábeis em Partidas Dobradas (Double-Entry Bookkeeping).
 * Monta as pernas de Débito e Crédito sem efetuar operações de I/O ou banco de dados,
 * respeitando as regras patrimoniais formais e garantindo equilíbrio matemático absoluto (Débito === Crédito).
 */
class LedgerCalculator {
  /**
   * Converte montantes com segurança para BigInt inteiro em Kwanzas (AOA).
   *
   * @param {bigint|number|string} val
   * @returns {bigint}
   */
  toBigInt(val) {
    if (typeof val === 'bigint') {
      return val;
    }
    if (typeof val === 'number') {
      if (!Number.isInteger(val)) {
        throw ValidationError.invalidValue('amount', 'O montante deve ser um inteiro de Kwanzas.');
      }
      return BigInt(val);
    }
    if (typeof val === 'string') {
      return BigInt(val.trim());
    }
    throw ValidationError.invalidValue('amount', 'Tipo de dado inválido para cálculo contábil.');
  }

  /**
   * Constrói os lançamentos para um Depósito confirmado na carteira do utilizador.
   * - Débito (Aumento do Ativo): Conta Transitória de Liquidação Interbancária
   * - Crédito (Aumento do Passivo Exigível): Conta Pessoal da Carteira do Utilizador
   *
   * @param {object} params
   * @param {string} params.systemSettlementAccountId - ID da conta '1001-SETTLEMENT-POOL' (ASSET)
   * @param {string} params.userLiabilityAccountId - ID da conta '2001-USER-...' (LIABILITY)
   * @param {number|bigint} params.netAmount - Montante líquido a creditar
   * @param {string} [params.systemRevenueAccountId] - ID da conta '4001-PLATFORM-REVENUE' (se houver comissão)
   * @param {number|bigint} [params.feeAmount=0]
   * @returns {Array<{ accountId: string, direction: 'DEBIT'|'CREDIT', amount: bigint, sequence: number }>}
   */
  calculateDepositEntries(params) {
    const {
      systemSettlementAccountId,
      userLiabilityAccountId,
      netAmount,
      systemRevenueAccountId = null,
      feeAmount = 0
    } = params;

    const net = this.toBigInt(netAmount);
    const fee = this.toBigInt(feeAmount);
    const totalGross = net + fee;

    if (net <= 0n) {
      throw ValidationError.invalidValue('netAmount', 'Montante líquido deve ser maior que zero.');
    }

    const entries = [];
    let sequence = 1;

    // Perna 1: Débito total recebido pelo banco no Ativo
    entries.push({
      accountId: systemSettlementAccountId,
      direction: 'DEBIT',
      amount: totalGross,
      sequence: sequence++
    });

    // Perna 2: Crédito líquido exigível devido ao utilizador no Passivo
    entries.push({
      accountId: userLiabilityAccountId,
      direction: 'CREDIT',
      amount: net,
      sequence: sequence++
    });

    // Perna 3 (opcional): Crédito da comissão da plataforma na Receita
    if (fee > 0n && systemRevenueAccountId) {
      entries.push({
        accountId: systemRevenueAccountId,
        direction: 'CREDIT',
        amount: fee,
        sequence: sequence++
      });
    }

    return entries;
  }

  /**
   * Constrói os lançamentos para a liquidação de um Levantamento de fundos.
   * - Débito (Redução do Passivo Exigível): Conta Pessoal do Utilizador
   * - Crédito (Saída do Ativo): Conta Transitória de Liquidação Interbancária
   * - Crédito (Receita): Comissão do levantamento (se aplicável)
   *
   * @param {object} params
   * @param {string} params.userLiabilityAccountId
   * @param {string} params.systemSettlementAccountId
   * @param {number|bigint} params.disbursedAmount - Montante transferido para a conta bancária/móvel
   * @param {string} [params.systemRevenueAccountId]
   * @param {number|bigint} [params.feeAmount=0]
   * @returns {Array<{ accountId: string, direction: 'DEBIT'|'CREDIT', amount: bigint, sequence: number }>}
   */
  calculateWithdrawalEntries(params) {
    const {
      userLiabilityAccountId,
      systemSettlementAccountId,
      disbursedAmount,
      systemRevenueAccountId = null,
      feeAmount = 0
    } = params;

    const disbursed = this.toBigInt(disbursedAmount);
    const fee = this.toBigInt(feeAmount);
    const totalDebited = disbursed + fee;

    if (disbursed <= 0n) {
      throw ValidationError.invalidValue('disbursedAmount', 'Montante a desembolsar deve ser superior a zero.');
    }

    const entries = [];
    let sequence = 1;

    // Débito no Passivo: cancelamento da obrigação da plataforma para com o utilizador
    entries.push({
      accountId: userLiabilityAccountId,
      direction: 'DEBIT',
      amount: totalDebited,
      sequence: sequence++
    });

    // Crédito no Ativo bancário: saída efetiva dos fundos custodiados
    entries.push({
      accountId: systemSettlementAccountId,
      direction: 'CREDIT',
      amount: disbursed,
      sequence: sequence++
    });

    // Crédito na Receita operacional se houver cobrança de tarifa
    if (fee > 0n && systemRevenueAccountId) {
      entries.push({
        accountId: systemRevenueAccountId,
        direction: 'CREDIT',
        amount: fee,
        sequence: sequence++
      });
    }

    return entries;
  }

  /**
   * Constrói os lançamentos para uma Transferência Interna direta entre dois membros da plataforma.
   * - Débito (Redução do Passivo do Remetente): Conta do Remetente
   * - Crédito (Aumento do Passivo do Destinatário): Conta do Destinatário
   *
   * @param {object} params
   * @param {string} params.senderLiabilityAccountId
   * @param {string} params.recipientLiabilityAccountId
   * @param {number|bigint} params.transferAmount
   * @returns {Array<{ accountId: string, direction: 'DEBIT'|'CREDIT', amount: bigint, sequence: number }>}
   */
  calculateInternalTransferEntries(params) {
    const {
      senderLiabilityAccountId,
      recipientLiabilityAccountId,
      transferAmount
    } = params;

    const amount = this.toBigInt(transferAmount);
    if (amount <= 0n) {
      throw ValidationError.invalidValue('transferAmount', 'Montante de transferência deve ser maior que zero.');
    }

    return [
      {
        accountId: senderLiabilityAccountId,
        direction: 'DEBIT',
        amount,
        sequence: 1
      },
      {
        accountId: recipientLiabilityAccountId,
        direction: 'CREDIT',
        amount,
        sequence: 2
      }
    ];
  }

  /**
   * Constrói os lançamentos para um Desembolso de Rotação (Recebimento do bolo da Kixikila).
   * - Débito (Ativo Transitório da Rodada): Conta Transitória de Arrecadação
   * - Crédito (Passivo Exigível do Beneficiário): Conta Pessoal do Beneficiário da vez
   *
   * @param {object} params
   * @param {string} params.poolSettlementAccountId
   * @param {string} params.beneficiaryLiabilityAccountId
   * @param {number|bigint} params.payoutAmount
   * @returns {Array<{ accountId: string, direction: 'DEBIT'|'CREDIT', amount: bigint, sequence: number }>}
   */
  calculateRotationPayoutEntries(params) {
    const {
      poolSettlementAccountId,
      beneficiaryLiabilityAccountId,
      payoutAmount
    } = params;

    const amount = this.toBigInt(payoutAmount);
    if (amount <= 0n) {
      throw ValidationError.invalidValue('payoutAmount', 'Montante do bolo da Kixikila deve ser maior que zero.');
    }

    return [
      {
        accountId: poolSettlementAccountId,
        direction: 'DEBIT',
        amount,
        sequence: 1
      },
      {
        accountId: beneficiaryLiabilityAccountId,
        direction: 'CREDIT',
        amount,
        sequence: 2
      }
    ];
  }

  /**
   * Inverte com exatidão as pernas de uma transação contábil prévia para estorno auditado (Reversal).
   * Cada perna que era DEBIT passa a ser CREDIT e vice-versa, mantendo o balanço rigoroso.
   *
   * @param {Array<{ accountId: string, direction: 'DEBIT'|'CREDIT', amount: number|bigint }>} originalEntries
   * @returns {Array<{ accountId: string, direction: 'DEBIT'|'CREDIT', amount: bigint, sequence: number }>}
   */
  calculateReversalEntries(originalEntries) {
    if (!Array.isArray(originalEntries) || originalEntries.length === 0) {
      throw new Error('Lista de lançamentos originais vazia para estorno.');
    }

    let sequence = 1;
    return originalEntries.map((entry) => ({
      accountId: entry.accountId || entry.account_id,
      direction: entry.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
      amount: this.toBigInt(entry.amount),
      sequence: sequence++
    }));
  }
}

// Instância singleton da calculadora do livro-razão
const ledgerCalculator = new LedgerCalculator();

module.exports = ledgerCalculator;