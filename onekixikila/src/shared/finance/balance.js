const Money = require('./money');
const ValidationError = require('../errors/validation-error');
const ConflictError = require('../errors/conflict-error');

/**
 * Utilitário de regras, validação de invariantes contábeis e transições de saldos
 * de carteiras na plataforma OneKixikila.
 *
 * Garante a conformidade estrita da equação fundamental da carteira:
 *   available_balance + locked_balance = ledger_balance
 * e a regra inegociável de não-negatividade:
 *   available_balance >= 0, locked_balance >= 0, ledger_balance >= 0
 */
class BalanceManager {
  /**
   * Converte com segurança montantes para instâncias BigInt.
   *
   * @param {bigint|number|string|Money} val
   * @returns {bigint}
   */
  toBigInt(val) {
    if (val instanceof Money) {
      return val.toBigInt();
    }
    if (typeof val === 'bigint') {
      return val;
    }
    if (typeof val === 'number') {
      if (!Number.isInteger(val)) {
        throw ValidationError.invalidValue('amount', 'Montantes devem ser expressos em unidades inteiras de Kwanza.');
      }
      return BigInt(val);
    }
    if (typeof val === 'string') {
      return BigInt(val.trim());
    }
    throw ValidationError.invalidValue('amount', 'Tipo de dado inválido para conversão monetária.');
  }

  /**
   * Valida a integridade contábil estrita de uma carteira.
   * Dispara exceção caso a equação contábil ou a não-negatividade sejam violadas.
   *
   * @param {object} wallet
   * @param {bigint|number} wallet.ledger_balance
   * @param {bigint|number} wallet.available_balance
   * @param {bigint|number} wallet.locked_balance
   * @returns {boolean} True se a carteira for íntegra
   */
  validateIntegrity(wallet) {
    if (!wallet) {
      throw ValidationError.fieldRequired('wallet');
    }

    const ledger = this.toBigInt(wallet.ledger_balance);
    const available = this.toBigInt(wallet.available_balance);
    const locked = this.toBigInt(wallet.locked_balance);

    if (available < 0n || locked < 0n || ledger < 0n) {
      throw new ConflictError(
        `Violação de não-negatividade na carteira: Disponível [${available}], Retido [${locked}], Contabilístico [${ledger}].`,
        'NEGATIVE_BALANCE_VIOLATION'
      );
    }

    if (available + locked !== ledger) {
      throw new ConflictError(
        `Quebra de invariante contábil na carteira: Disponível (${available}) + Retido (${locked}) != Contabilístico (${ledger}).`,
        'BALANCE_EQUATION_MISMATCH'
      );
    }

    return true;
  }

  /**
   * Verifica se a carteira detém saldo disponível suficiente para suportar um débito.
   *
   * @param {object} wallet
   * @param {bigint|number|Money} debitAmount
   * @returns {boolean}
   */
  hasSufficientAvailableBalance(wallet, debitAmount) {
    this.validateIntegrity(wallet);
    const amount = this.toBigInt(debitAmount);

    if (amount <= 0n) {
      throw ValidationError.invalidValue('debitAmount', 'O montante de débito deve ser estritamente superior a zero.');
    }

    const available = this.toBigInt(wallet.available_balance);
    return available >= amount;
  }

  /**
   * Reserva fundos na carteira (ex: ordem de levantamento em análise ou lance de rotação).
   * Move o montante do saldo disponível para o saldo retido, mantendo o saldo contabilístico inalterado.
   *
   * @param {object} wallet
   * @param {bigint|number|Money} amountToReserve
   * @returns {{ ledger_balance: number, available_balance: number, locked_balance: number }} Novos saldos calculados
   */
  reserveFunds(wallet, amountToReserve) {
    const amount = this.toBigInt(amountToReserve);
    if (!this.hasSufficientAvailableBalance(wallet, amount)) {
      throw new ConflictError(
        'Saldo disponível insuficiente para efetuar a reserva de fundos na carteira.',
        'INSUFFICIENT_AVAILABLE_FUNDS'
      );
    }

    const ledger = this.toBigInt(wallet.ledger_balance);
    const available = this.toBigInt(wallet.available_balance) - amount;
    const locked = this.toBigInt(wallet.locked_balance) + amount;

    const updated = {
      ledger_balance: Number(ledger),
      available_balance: Number(available),
      locked_balance: Number(locked)
    };

    this.validateIntegrity(updated);
    return updated;
  }

  /**
   * Liberta fundos previamente reservados de volta para o saldo disponível
   * (ex: levantamento rejeitado ou cancelado pelo prestador de pagamento).
   *
   * @param {object} wallet
   * @param {bigint|number|Money} amountToRelease
   * @returns {{ ledger_balance: number, available_balance: number, locked_balance: number }}
   */
  releaseReservedFunds(wallet, amountToRelease) {
    this.validateIntegrity(wallet);
    const amount = this.toBigInt(amountToRelease);

    if (amount <= 0n) {
      throw ValidationError.invalidValue('amountToRelease', 'Montante a libertar deve ser maior que zero.');
    }

    const locked = this.toBigInt(wallet.locked_balance);
    if (locked < amount) {
      throw new ConflictError(
        `Tentativa de libertar montante (${amount}) superior ao saldo retido disponível (${locked}).`,
        'EXCESSIVE_FUNDS_RELEASE'
      );
    }

    const ledger = this.toBigInt(wallet.ledger_balance);
    const available = this.toBigInt(wallet.available_balance) + amount;
    const newLocked = locked - amount;

    const updated = {
      ledger_balance: Number(ledger),
      available_balance: Number(available),
      locked_balance: Number(newLocked)
    };

    this.validateIntegrity(updated);
    return updated;
  }

  /**
   * Consolida a liquidação de fundos reservados (ex: levantamento bancário concluído com sucesso).
   * Reduz o saldo retido e o saldo contabilístico simultaneamente.
   *
   * @param {object} wallet
   * @param {bigint|number|Money} amountToCommit
   * @returns {{ ledger_balance: number, available_balance: number, locked_balance: number }}
   */
  commitReservedFunds(wallet, amountToCommit) {
    this.validateIntegrity(wallet);
    const amount = this.toBigInt(amountToCommit);

    if (amount <= 0n) {
      throw ValidationError.invalidValue('amountToCommit', 'Montante a liquidar deve ser maior que zero.');
    }

    const locked = this.toBigInt(wallet.locked_balance);
    if (locked < amount) {
      throw new ConflictError(
        `Saldo retido insuficiente (${locked}) para consumação da liquidação (${amount}).`,
        'INSUFFICIENT_LOCKED_FUNDS'
      );
    }

    const ledger = this.toBigInt(wallet.ledger_balance) - amount;
    const available = this.toBigInt(wallet.available_balance);
    const newLocked = locked - amount;

    const updated = {
      ledger_balance: Number(ledger),
      available_balance: Number(available),
      locked_balance: Number(newLocked)
    };

    this.validateIntegrity(updated);
    return updated;
  }

  /**
   * Credita fundos na carteira (ex: depósito confirmado ou recebimento do bolo de Kixikila).
   * Incrementa o saldo contabilístico e o saldo disponível em valor idêntico.
   *
   * @param {object} wallet
   * @param {bigint|number|Money} amountToCredit
   * @returns {{ ledger_balance: number, available_balance: number, locked_balance: number }}
   */
  creditFunds(wallet, amountToCredit) {
    this.validateIntegrity(wallet);
    const amount = this.toBigInt(amountToCredit);

    if (amount <= 0n) {
      throw ValidationError.invalidValue('amountToCredit', 'Montante de crédito deve ser estritamente positivo.');
    }

    const ledger = this.toBigInt(wallet.ledger_balance) + amount;
    const available = this.toBigInt(wallet.available_balance) + amount;
    const locked = this.toBigInt(wallet.locked_balance);

    const updated = {
      ledger_balance: Number(ledger),
      available_balance: Number(available),
      locked_balance: Number(locked)
    };

    this.validateIntegrity(updated);
    return updated;
  }

  /**
   * Executa um débito direto no saldo disponível (ex: pagamento de quota ou transferência interna imediata).
   * Reduz o saldo disponível e o saldo contabilístico na mesma proporção.
   *
   * @param {object} wallet
   * @param {bigint|number|Money} amountToDebit
   * @returns {{ ledger_balance: number, available_balance: number, locked_balance: number }}
   */
  directDebitFunds(wallet, amountToDebit) {
    const amount = this.toBigInt(amountToDebit);

    if (!this.hasSufficientAvailableBalance(wallet, amount)) {
      throw new ConflictError(
        'Saldo disponível insuficiente na carteira para realizar o débito imediato.',
        'INSUFFICIENT_AVAILABLE_FUNDS'
      );
    }

    const ledger = this.toBigInt(wallet.ledger_balance) - amount;
    const available = this.toBigInt(wallet.available_balance) - amount;
    const locked = this.toBigInt(wallet.locked_balance);

    const updated = {
      ledger_balance: Number(ledger),
      available_balance: Number(available),
      locked_balance: Number(locked)
    };

    this.validateIntegrity(updated);
    return updated;
  }
}

// Instância singleton do gestor de saldos
const balanceManager = new BalanceManager();

module.exports = balanceManager;