const transfersRepository = require('./transfers.repository');
const transfersPolicy = require('./transfers.policy');
const authRepository = require('../auth/auth.repository');
const feesService = require('../fees/fees.service');
const ledgerService = require('../ledger/ledger.service');
const ledgerCalculator = require('../ledger/ledger-calculator');
const balanceManager = require('../../shared/finance/balance');
const financialIdempotency = require('../../shared/finance/idempotency');
const Money = require('../../shared/finance/money');
const { withTransaction } = require('../../database/transaction');
const { queryOneClient, queryClient } = require('../../database/query');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço de regras de negócio para Transferências Internas entre Carteiras (P2P).
 * Orquestra transferências diretas em Kwanzas (AOA) entre membros da plataforma,
 * garantindo ordenação estrita de bloqueios para evitar deadlocks, liquidação contábil
 * atômica em partidas dobradas no livro-razão e verificação de limites operacionais.
 */
class TransfersService {
  /**
   * Executa uma transferência financeira interna direta para outro membro da plataforma.
   *
   * @param {object} actingUser - Utilizador autenticado remetente (req.user)
   * @param {object} transferData - Parâmetros { recipientIdentifier, amount, description, idempotencyKey }
   * @param {object} [context={}] - Metadados de rastreamento e auditoria
   * @returns {Promise<object>} Ficha da transferência concluída
   */
  async transferFunds(actingUser, transferData, context = {}) {
    const {
      recipientIdentifier,
      amount,
      description = 'Transferência interna OneKixikila',
      idempotencyKey: providedKey
    } = transferData;

    if (!recipientIdentifier) {
      throw ValidationError.fieldRequired('recipientIdentifier');
    }

    const transferAmountBigInt = BigInt(amount);
    if (transferAmountBigInt <= 0n) {
      throw ValidationError.invalidValue('amount', 'O montante de transferência deve ser estritamente superior a zero.');
    }

    // 1. Obtém a carteira do remetente
    const senderWalletSql = `
      SELECT id, user_id, status, available_balance, ledger_balance, locked_balance, currency
      FROM wallets
      WHERE user_id = $1;
    `;
    const senderWallet = await withTransaction((client) => queryOneClient(client, senderWalletSql, [actingUser.id]));
    if (!senderWallet) {
      throw NotFoundError.wallet(actingUser.id);
    }

    // 2. Localiza o utilizador destinatário (por email, telefone ou UUID)
    let recipientUser = null;
    const cleanIdentifier = String(recipientIdentifier).trim();

    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanIdentifier)) {
      recipientUser = await authRepository.findById(cleanIdentifier);
    } else {
      recipientUser = await authRepository.findByIdentifier(cleanIdentifier);
    }

    if (!recipientUser) {
      throw new NotFoundError(`Destinatário [${cleanIdentifier}] não foi localizado na plataforma. Verifique o telefone ou e-mail informado.`, 'RECIPIENT_NOT_FOUND');
    }

    // 3. Previne auto-transferência
    if (actingUser.id === recipientUser.id) {
      throw new ConflictError('Não é permitido efetuar transferências para a sua própria conta.', 'SELF_TRANSFER_BLOCKED');
    }

    // 4. Obtém a carteira do destinatário
    const recipientWalletSql = `
      SELECT id, user_id, status, available_balance, ledger_balance, locked_balance, currency
      FROM wallets
      WHERE user_id = $1;
    `;
    const recipientWallet = await withTransaction((client) => queryOneClient(client, recipientWalletSql, [recipientUser.id]));
    if (!recipientWallet) {
      throw new NotFoundError('Carteira digital do destinatário não configurada.', 'RECIPIENT_WALLET_NOT_FOUND');
    }

    // 5. Apura volumes já transferidos hoje e no mês para conformidade
    const volumes = await transfersRepository.getUserTransferredVolumes(actingUser.id);

    // 6. Calcula eventuais tarifas institucionais (padrão zero para transferências P2P)
    const feeCalculation = await feesService.calculateFee('INTERNAL_TRANSFER', transferAmountBigInt);
    const feeAmountBigInt = BigInt(feeCalculation.feeAmount || 0);
    const totalRequiredBigInt = transferAmountBigInt + feeAmountBigInt;

    // 7. Validação das políticas de acesso, status das carteiras e limites prudenciais
    const policyCheck = transfersPolicy.canTransferFunds(
      actingUser,
      senderWallet,
      recipientUser,
      recipientWallet,
      transferAmountBigInt,
      totalRequiredBigInt,
      volumes
    );
    if (!policyCheck.allowed) {
      const err = new ConflictError(policyCheck.reason, 'TRANSFER_POLICY_VIOLATION');
      err.statusCode = policyCheck.statusCode || 403;
      err.status = err.statusCode;
      throw err;
    }

    // 8. Gestão da chave de idempotência financeira
    const idempotencyKey = providedKey
      ? financialIdempotency.validateKey(providedKey)
      : financialIdempotency.generateKey('TRANS', actingUser.id, Date.now());

    // 9. Verificação de reenvio prévio idêntico
    const existing = await transfersRepository.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      return {
        id: existing.id,
        referenceNumber: existing.reference_number,
        amount: Number(existing.amount),
        status: existing.status,
        message: 'Transferência previamente executada retornada por idempotência.'
      };
    }

    const referenceNumber = `TRF-${actingUser.id.slice(0, 4).toUpperCase()}-${Date.now()}`;

    // 10. Execução transacional atômica com prevenção de deadlock na aquisição de bloqueios
    const executionResult = await withTransaction(async (client) => {
      // Ordena os IDs das carteiras lexicograficamente para adquirir bloqueios sempre na mesma ordem
      const walletIdsOrdered = [senderWallet.id, recipientWallet.id].sort();

      const lockWalletSql = `
        SELECT id, user_id, ledger_balance, available_balance, locked_balance, status
        FROM wallets
        WHERE id = $1
        FOR UPDATE;
      `;

      let lockedWallet1 = await queryOneClient(client, lockWalletSql, [walletIdsOrdered[0]]);
      let lockedWallet2 = await queryOneClient(client, lockWalletSql, [walletIdsOrdered[1]]);

      const lockedSender = lockedWallet1.id === senderWallet.id ? lockedWallet1 : lockedWallet2;
      const lockedRecipient = lockedWallet1.id === recipientWallet.id ? lockedWallet1 : lockedWallet2;

      // Revalida solvência sob bloqueio
      if (!balanceManager.hasSufficientAvailableBalance(lockedSender, totalRequiredBigInt)) {
        throw new ConflictError('Saldo disponível insuficiente para realizar a transferência.', 'INSUFFICIENT_AVAILABLE_FUNDS');
      }

      // Calcula os novos saldos de ambas as partes
      const updatedSenderBalances = balanceManager.directDebitFunds(lockedSender, totalRequiredBigInt);
      const updatedRecipientBalances = balanceManager.creditFunds(lockedRecipient, transferAmountBigInt);

      // Atualiza saldos da carteira do remetente
      await queryClient(
        client,
        `UPDATE wallets
         SET ledger_balance = $1,
             available_balance = $2,
             locked_balance = $3,
             updated_at = NOW() AT TIME ZONE 'UTC'
         WHERE id = $4;`,
        [updatedSenderBalances.ledger_balance, updatedSenderBalances.available_balance, updatedSenderBalances.locked_balance, lockedSender.id]
      );

      // Atualiza saldos da carteira do destinatário
      await queryClient(
        client,
        `UPDATE wallets
         SET ledger_balance = $1,
             available_balance = $2,
             locked_balance = $3,
             updated_at = NOW() AT TIME ZONE 'UTC'
         WHERE id = $4;`,
        [updatedRecipientBalances.ledger_balance, updatedRecipientBalances.available_balance, updatedRecipientBalances.locked_balance, lockedRecipient.id]
      );

      // Localiza contas contábeis de passivo exigível no livro-razão
      const senderAccSql = `SELECT id FROM ledger_accounts WHERE user_id = $1 AND wallet_id = $2;`;
      const senderAcc = await queryOneClient(client, senderAccSql, [actingUser.id, lockedSender.id]);

      const recipientAccSql = `SELECT id FROM ledger_accounts WHERE user_id = $1 AND wallet_id = $2;`;
      const recipientAcc = await queryOneClient(client, recipientAccSql, [recipientUser.id, lockedRecipient.id]);

      // Monta as pernas contábeis de transferência entre utilizadores
      const ledgerEntries = ledgerCalculator.calculateInternalTransferEntries({
        senderLiabilityAccountId: senderAcc.id,
        recipientLiabilityAccountId: recipientAcc.id,
        transferAmount: transferAmountBigInt
      });

      // Se houver cobrança de comissão institucional, adiciona a respectiva perna
      if (feeAmountBigInt > 0n) {
        const sysRevenueSql = `SELECT id FROM ledger_accounts WHERE account_code = '4001-PLATFORM-REVENUE';`;
        const sysRevenue = await queryOneClient(client, sysRevenueSql);
        if (sysRevenue) {
          ledgerEntries.push({
            accountId: sysRevenue.id,
            direction: 'CREDIT',
            amount: feeAmountBigInt,
            sequence: 3
          });
        }
      }

      const txReferenceCode = `LTX-TRF-${referenceNumber}`;
      const ledgerTx = await ledgerService.recordDoubleEntryTransaction(
        {
          referenceCode: txReferenceCode,
          idempotencyKey: `IDEMP-LTX-${idempotencyKey}`,
          operationType: 'INTERNAL_TRANSFER',
          amount: totalRequiredBigInt,
          description: `Transferência interna para ${recipientUser.full_name || recipientUser.email}`,
          entries: ledgerEntries,
          metadata: {
            referenceNumber,
            senderUserId: actingUser.id,
            recipientUserId: recipientUser.id,
            senderWalletId: lockedSender.id,
            recipientWalletId: lockedRecipient.id
          }
        },
        client
      );

      // Cria o registro na tabela internal_transfers
      const transferRecord = await transfersRepository.createTransfer(
        {
          referenceNumber,
          idempotencyKey,
          senderWalletId: lockedSender.id,
          senderUserId: actingUser.id,
          recipientWalletId: lockedRecipient.id,
          recipientUserId: recipientUser.id,
          amount: Number(transferAmountBigInt),
          feeAmount: Number(feeAmountBigInt),
          currency: 'AOA',
          status: 'COMPLETED',
          description,
          ledgerTransactionId: ledgerTx.id
        },
        client
      );

      return {
        transfer: transferRecord,
        ledgerTransactionId: ledgerTx.id,
        senderNewAvailableBalance: updatedSenderBalances.available_balance
      };
    });

    eventBus.publish(
      EVENT_TYPES.TRANSFER_INTERNAL_COMPLETED,
      {
        transferId: executionResult.transfer.id,
        referenceNumber,
        senderUserId: actingUser.id,
        recipientUserId: recipientUser.id,
        amount: Number(transferAmountBigInt),
        feeAmount: Number(feeAmountBigInt)
      },
      { requestId: context.requestId }
    );

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'FINANCIAL_TRANSACTION',
        resourceType: 'INTERNAL_TRANSFER',
        resourceId: executionResult.transfer.id,
        metadata: {
          referenceNumber,
          amount: Number(transferAmountBigInt),
          recipientUserId: recipientUser.id,
          ledgerTransactionId: executionResult.ledgerTransactionId
        }
      });
    }

    return {
      success: true,
      status: 'COMPLETED',
      transferId: executionResult.transfer.id,
      referenceNumber,
      amount: Number(transferAmountBigInt),
      feeAmount: Number(feeAmountBigInt),
      currency: 'AOA',
      recipientName: recipientUser.full_name || recipientUser.email,
      senderNewAvailableBalance: executionResult.senderNewAvailableBalance,
      ledgerTransactionId: executionResult.ledgerTransactionId,
      message: `Transferência de ${Money.of(transferAmountBigInt, 'AOA').format()} realizada com sucesso para ${recipientUser.full_name || recipientUser.email}.`
    };
  }

  /**
   * Consulta os dados detalhados e o comprovativo de uma transferência por UUID (Anti-IDOR).
   *
   * @param {object} actingUser
   * @param {string} transferId
   * @returns {Promise<object>}
   */
  async getTransferById(actingUser, transferId) {
    const transfer = await transfersRepository.findById(transferId);
    if (!transfer) {
      throw NotFoundError.resource('Transferência', transferId);
    }

    if (!transfersPolicy.canViewTransfer(actingUser, transfer)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado aos dados desta transferência.');
    }

    const isSender = actingUser.id === transfer.sender_user_id;

    return {
      id: transfer.id,
      referenceNumber: transfer.reference_number,
      amount: Number(transfer.amount),
      feeAmount: Number(transfer.fee_amount),
      currency: transfer.currency || 'AOA',
      formattedAmount: Money.of(transfer.amount, transfer.currency).format(),
      status: transfer.status,
      description: transfer.description,
      isSender,
      counterpartyName: isSender ? transfer.recipient_name : transfer.sender_name,
      counterpartyEmail: isSender ? transfer.recipient_email : transfer.sender_email,
      completedAt: transfer.completed_at,
      createdAt: transfer.created_at
    };
  }

  /**
   * Consulta o histórico paginado de transferências enviadas pelo utilizador.
   *
   * @param {object} user - Utilizador autenticado (req.user)
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listUserSentTransfers(user, filters, paginationParams) {
    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await transfersRepository.listSentTransfers(user.id, filters, { limit, offset });

    const formattedRows = rows.map((t) => ({
      id: t.id,
      referenceNumber: t.reference_number,
      amount: Number(t.amount),
      feeAmount: Number(t.fee_amount),
      currency: t.currency || 'AOA',
      formattedAmount: Money.of(t.amount, t.currency).format(),
      status: t.status,
      description: t.description,
      recipientName: t.recipient_name,
      completedAt: t.completed_at,
      createdAt: t.created_at
    }));

    return formatPaginatedResult({
      data: formattedRows,
      totalCount,
      page,
      limit
    });
  }

  /**
   * Consulta o histórico paginado de transferências recebidas pelo utilizador.
   *
   * @param {object} user - Utilizador autenticado (req.user)
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listUserReceivedTransfers(user, filters, paginationParams) {
    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await transfersRepository.listReceivedTransfers(user.id, filters, { limit, offset });

    const formattedRows = rows.map((t) => ({
      id: t.id,
      referenceNumber: t.reference_number,
      amount: Number(t.amount),
      feeAmount: Number(t.fee_amount),
      currency: t.currency || 'AOA',
      formattedAmount: Money.of(t.amount, t.currency).format(),
      status: t.status,
      description: t.description,
      senderName: t.sender_name,
      completedAt: t.completed_at,
      createdAt: t.created_at
    }));

    return formatPaginatedResult({
      data: formattedRows,
      totalCount,
      page,
      limit
    });
  }
}

// Instância singleton do serviço de transferências
const transfersService = new TransfersService();

module.exports = transfersService;