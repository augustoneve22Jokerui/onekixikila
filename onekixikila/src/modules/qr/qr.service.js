const QRCode = require('qrcode');
const qrRepository = require('./qr.repository');
const qrPolicy = require('./qr.policy');
const groupsRepository = require('../groups/groups.repository');
const ledgerService = require('../ledger/ledger.service');
const ledgerCalculator = require('../ledger/ledger-calculator');
const balanceManager = require('../../shared/finance/balance');
const financialIdempotency = require('../../shared/finance/idempotency');
const cryptoUtils = require('../../shared/utils/crypto');
const limitsConfig = require('../../config/limits');
const appConfig = require('../../config/app');
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
 * Serviço de regras de negócio para Emissão, Resolução e Liquidação de Códigos QR
 * da plataforma OneKixikila.
 * Gerencia tokens criptográficos de alta entropia para convites dinâmicos de grupos,
 * cobranças presenciais na carteira digital e liquidações de ponto a ponto (P2P).
 */
class QrService {
  /**
   * Emite um Código QR dinâmico e seguro para convite de adesão a um grupo de Kixikila.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} groupId - UUID do grupo
   * @param {object} options - Parâmetros { maxScans, expiresInMinutes }
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async generateGroupInviteQr(actingUser, groupId, options = {}, context = {}) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const { maxScans = 10, expiresInMinutes = 10080 } = options; // Padrão 7 dias (10080 min)
    const tokenCode = `QRI-${cryptoUtils.randomAlphanumeric(24)}`;
    const expiresAt = new Date(Date.now() + Number(expiresInMinutes) * 60 * 1000);

    const qrToken = await qrRepository.createQrToken({
      tokenCode,
      qrType: 'GROUP_INVITE',
      creatorUserId: actingUser.id,
      targetGroupId: group.id,
      targetWalletId: null,
      paymentRequestId: null,
      fixedAmount: null,
      currency: 'AOA',
      maxScans: Number(maxScans),
      expiresAt,
      metadata: {
        groupName: group.name,
        groupSlug: group.slug,
        frequency: group.frequency,
        contributionAmount: Number(group.contribution_amount)
      }
    });

    const invitePayload = `${appConfig.baseUrl}/groups/join?qr=${tokenCode}`;
    const qrCodeDataUrl = await QRCode.toDataURL(invitePayload, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'CREATE',
        resourceType: 'QR_TOKEN',
        resourceId: qrToken.id,
        metadata: {
          qrType: 'GROUP_INVITE',
          groupId: group.id,
          maxScans: qrToken.max_scans,
          expiresAt: qrToken.expires_at
        }
      });
    }

    return {
      qrTokenId: qrToken.id,
      tokenCode: qrToken.token_code,
      qrType: qrToken.qr_type,
      qrCodeDataUrl,
      targetGroupId: group.id,
      groupName: group.name,
      maxScans: qrToken.max_scans,
      expiresAt: qrToken.expires_at
    };
  }

  /**
   * Emite um Código QR dinâmico para cobrança ou recebimento financeiro na carteira digital (AOA).
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} paymentData - { fixedAmount, maxScans, expiresInMinutes, description }
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async generatePaymentQr(actingUser, paymentData = {}, context = {}) {
    const {
      fixedAmount = null,
      maxScans = 1,
      expiresInMinutes = 15, // Padrão de 15 minutos para cobrança dinâmica
      description = 'Cobrança via QR Code OneKixikila'
    } = paymentData;

    // Localiza a carteira digital do utilizador emissor (destinatário dos fundos)
    const walletSql = `SELECT id, user_id, status FROM wallets WHERE user_id = $1;`;
    const wallet = await withTransaction((client) => queryOneClient(client, walletSql, [actingUser.id]));
    if (!wallet) {
      throw NotFoundError.wallet(actingUser.id);
    }

    if (wallet.status !== 'ACTIVE') {
      throw new ConflictError(
        `A sua carteira digital encontra-se no estado [${wallet.status}]. Emissão de cobrança bloqueada.`,
        'WALLET_INACTIVE'
      );
    }

    let parsedAmount = null;
    if (fixedAmount !== null && fixedAmount !== undefined) {
      const amountBigInt = BigInt(fixedAmount);
      if (amountBigInt <= 0n) {
        throw ValidationError.invalidValue('fixedAmount', 'O montante fixo da cobrança deve ser superior a zero.');
      }
      parsedAmount = Number(amountBigInt);
    }

    const tokenCode = `QRP-${cryptoUtils.randomAlphanumeric(24)}`;
    const ttlMinutes = Math.min(Math.max(Number(expiresInMinutes), 5), 1440); // Entre 5 minutos e 24 horas
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    const qrToken = await qrRepository.createQrToken({
      tokenCode,
      qrType: 'PAYMENT_RECEIVE',
      creatorUserId: actingUser.id,
      targetGroupId: null,
      targetWalletId: wallet.id,
      paymentRequestId: null,
      fixedAmount: parsedAmount,
      currency: 'AOA',
      maxScans: Number(maxScans),
      expiresAt,
      metadata: {
        recipientName: actingUser.fullName || 'Utilizador OneKixikila',
        description
      }
    });

    const paymentPayload = JSON.stringify({
      app: 'OneKixikila',
      type: 'PAYMENT',
      code: tokenCode,
      amount: parsedAmount,
      currency: 'AOA'
    });

    const qrCodeDataUrl = await QRCode.toDataURL(paymentPayload, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 320
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'CREATE',
        resourceType: 'QR_TOKEN',
        resourceId: qrToken.id,
        metadata: {
          qrType: 'PAYMENT_RECEIVE',
          walletId: wallet.id,
          fixedAmount: parsedAmount,
          expiresAt: qrToken.expires_at
        }
      });
    }

    return {
      qrTokenId: qrToken.id,
      tokenCode: qrToken.token_code,
      qrType: qrToken.qr_type,
      qrCodeDataUrl,
      fixedAmount: parsedAmount,
      currency: 'AOA',
      maxScans: qrToken.max_scans,
      expiresAt: qrToken.expires_at
    };
  }

  /**
   * Resolve e decodifica um token QR lido pelo scanner de forma segura.
   * Não expõe documentos, saldos ou dados confidenciais do emissor.
   *
   * @param {object} actingUser - Utilizador autenticado que realizou a leitura
   * @param {string} tokenCode - Código textual contido no QR Code
   * @returns {Promise<object>} Instruções de ação e metadados higienizados
   */
  async resolveQrToken(actingUser, tokenCode) {
    const qrToken = await qrRepository.findByTokenCode(tokenCode);
    if (!qrToken) {
      throw NotFoundError.resource('Código QR', tokenCode);
    }

    const usableCheck = qrPolicy.isQrTokenUsable(qrToken);
    if (!usableCheck.usable) {
      throw new ConflictError(usableCheck.reason, 'QR_TOKEN_UNUSABLE');
    }

    if (qrToken.qr_type === 'GROUP_INVITE') {
      return {
        qrType: 'GROUP_INVITE',
        tokenCode: qrToken.token_code,
        group: {
          id: qrToken.target_group_id,
          name: qrToken.group_name,
          slug: qrToken.group_slug,
          status: qrToken.group_status,
          contributionAmount: Number(qrToken.group_contribution_amount || 0),
          frequency: qrToken.group_frequency
        },
        creatorName: qrToken.creator_name,
        expiresAt: qrToken.expires_at
      };
    }

    if (qrToken.qr_type === 'PAYMENT_RECEIVE' || qrToken.qr_type === 'DIRECT_TRANSFER') {
      const isSelf = actingUser && actingUser.id === qrToken.creator_user_id;

      return {
        qrType: qrToken.qr_type,
        tokenCode: qrToken.token_code,
        recipient: {
          name: qrToken.creator_name,
          isSelf
        },
        fixedAmount: qrToken.fixed_amount ? Number(qrToken.fixed_amount) : null,
        currency: qrToken.currency || 'AOA',
        description: qrToken.metadata && qrToken.metadata.description ? qrToken.metadata.description : 'Transferência via QR Code',
        expiresAt: qrToken.expires_at
      };
    }

    return {
      qrType: qrToken.qr_type,
      tokenCode: qrToken.token_code,
      expiresAt: qrToken.expires_at
    };
  }

  /**
   * Executa a liquidação financeira de um Código QR de cobrança previamente escaneado.
   * Transfere o montante da carteira do pagador para a carteira do emissor com dupla partida contábil.
   *
   * @param {object} actingUser - Utilizador autenticado pagador (req.user)
   * @param {object} paymentParams - { tokenCode, amount, idempotencyKey, description }
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async consumePaymentQr(actingUser, paymentParams, context = {}) {
    const {
      tokenCode,
      amount: providedAmount,
      idempotencyKey: providedKey,
      description = 'Pagamento presencial via QR Code'
    } = paymentParams;

    if (!tokenCode) {
      throw ValidationError.fieldRequired('tokenCode');
    }

    // 1. Localiza e valida o token QR
    const qrToken = await qrRepository.findByTokenCode(tokenCode);
    if (!qrToken) {
      throw NotFoundError.resource('Código QR', tokenCode);
    }

    const usableCheck = qrPolicy.isQrTokenUsable(qrToken);
    if (!usableCheck.usable) {
      throw new ConflictError(usableCheck.reason, 'QR_TOKEN_UNUSABLE');
    }

    if (qrToken.qr_type !== 'PAYMENT_RECEIVE' && qrToken.qr_type !== 'DIRECT_TRANSFER') {
      throw new ConflictError('Este Código QR não é elegível para liquidação financeira.', 'INVALID_QR_OPERATION');
    }

    // 2. Previne autopagamento acidental
    if (actingUser.id === qrToken.creator_user_id) {
      throw new ConflictError('Não é permitido efetuar pagamentos ou transferências para a sua própria conta.', 'SELF_PAYMENT_BLOCKED');
    }

    // 3. Determinação do montante a transferir
    let transferAmountBigInt;
    if (qrToken.fixed_amount !== null && qrToken.fixed_amount !== undefined) {
      transferAmountBigInt = BigInt(qrToken.fixed_amount);
    } else {
      if (!providedAmount) {
        throw ValidationError.fieldRequired('amount');
      }
      transferAmountBigInt = BigInt(providedAmount);
    }

    if (transferAmountBigInt <= 0n) {
      throw ValidationError.invalidValue('amount', 'O montante de pagamento deve ser estritamente superior a zero.');
    }

    // 4. Gestão da chave de idempotência
    const idempotencyKey = providedKey
      ? financialIdempotency.validateKey(providedKey)
      : financialIdempotency.generateKey('QRPAY', qrToken.id, actingUser.id);

    // 5. Execução transacional atômica da transferência
    const transferResult = await withTransaction(async (client) => {
      // Bloqueio pessimista de concorrência na carteira do pagador
      const senderWalletSql = `
        SELECT id, user_id, ledger_balance, available_balance, locked_balance, status
        FROM wallets
        WHERE user_id = $1
        FOR UPDATE;
      `;
      const senderWallet = await queryOneClient(client, senderWalletSql, [actingUser.id]);
      if (!senderWallet) {
        throw NotFoundError.wallet(actingUser.id);
      }

      if (senderWallet.status !== 'ACTIVE') {
        throw new ConflictError(`A sua carteira digital encontra-se no estado [${senderWallet.status}].`, 'WALLET_INACTIVE');
      }

      // Bloqueio na carteira do destinatário (emissor do QR)
      const recipientWalletSql = `
        SELECT id, user_id, ledger_balance, available_balance, locked_balance, status
        FROM wallets
        WHERE id = $1
        FOR UPDATE;
      `;
      const recipientWallet = await queryOneClient(client, recipientWalletSql, [qrToken.target_wallet_id]);
      if (!recipientWallet) {
        throw NotFoundError.wallet(qrToken.target_wallet_id);
      }

      if (recipientWallet.status !== 'ACTIVE') {
        throw new ConflictError('A carteira do destinatário encontra-se indisponível para receber fundos.', 'RECIPIENT_WALLET_INACTIVE');
      }

      // Verifica solvência da carteira do pagador
      if (!balanceManager.hasSufficientAvailableBalance(senderWallet, transferAmountBigInt)) {
        throw new ConflictError('Saldo disponível insuficiente na carteira para concluir o pagamento.', 'INSUFFICIENT_FUNDS');
      }

      // Calcula os novos saldos
      const updatedSender = balanceManager.directDebitFunds(senderWallet, transferAmountBigInt);
      const updatedRecipient = balanceManager.creditFunds(recipientWallet, transferAmountBigInt);

      // Persiste saldos atualizados
      await queryClient(
        client,
        `UPDATE wallets SET ledger_balance = $1, available_balance = $2, locked_balance = $3, updated_at = NOW() AT TIME ZONE 'UTC' WHERE id = $4;`,
        [updatedSender.ledger_balance, updatedSender.available_balance, updatedSender.locked_balance, senderWallet.id]
      );

      await queryClient(
        client,
        `UPDATE wallets SET ledger_balance = $1, available_balance = $2, locked_balance = $3, updated_at = NOW() AT TIME ZONE 'UTC' WHERE id = $4;`,
        [updatedRecipient.ledger_balance, updatedRecipient.available_balance, updatedRecipient.locked_balance, recipientWallet.id]
      );

      // Localiza contas do livro-razão para partidas dobradas
      const senderAccSql = `SELECT id FROM ledger_accounts WHERE user_id = $1 AND wallet_id = $2;`;
      const senderAcc = await queryOneClient(client, senderAccSql, [actingUser.id, senderWallet.id]);

      const recipientAccSql = `SELECT id FROM ledger_accounts WHERE user_id = $1 AND wallet_id = $2;`;
      const recipientAcc = await queryOneClient(client, recipientAccSql, [recipientWallet.user_id, recipientWallet.id]);

      // Monta as pernas contábeis de transferência direta
      const ledgerEntries = ledgerCalculator.calculateInternalTransferEntries({
        senderLiabilityAccountId: senderAcc.id,
        recipientLiabilityAccountId: recipientAcc.id,
        transferAmount: transferAmountBigInt
      });

      const txReferenceCode = `LTX-QR-${actingUser.id.slice(0, 6)}-${Date.now()}`;
      const ledgerTx = await ledgerService.recordDoubleEntryTransaction(
        {
          referenceCode: txReferenceCode,
          idempotencyKey: `IDEMP-LTX-${idempotencyKey}`,
          operationType: 'INTERNAL_TRANSFER',
          amount: transferAmountBigInt,
          description: `Pagamento via QR Code para ${qrToken.creator_name}`,
          entries: ledgerEntries,
          metadata: {
            qrTokenId: qrToken.id,
            recipientUserId: qrToken.creator_user_id,
            tokenCode: qrToken.token_code
          }
        },
        client
      );

      // Incrementa a leitura/consumo do QR token
      await qrRepository.incrementScanCount(qrToken.id, client);

      return {
        amountPaid: Number(transferAmountBigInt),
        recipientName: qrToken.creator_name,
        ledgerTransactionId: ledgerTx.id,
        senderNewAvailableBalance: updatedSender.available_balance
      };
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'FINANCIAL_TRANSACTION',
        resourceType: 'QR_PAYMENT',
        resourceId: qrToken.id,
        metadata: {
          tokenCode: qrToken.token_code,
          amount: transferResult.amountPaid,
          recipientUserId: qrToken.creator_user_id,
          ledgerTransactionId: transferResult.ledgerTransactionId
        }
      });
    }

    return {
      success: true,
      status: 'SETTLED',
      message: `Pagamento de ${transferResult.amountPaid.toLocaleString('pt-AO')} Kz realizado com sucesso para ${transferResult.recipientName}.`,
      amountPaid: transferResult.amountPaid,
      currency: 'AOA',
      ledgerTransactionId: transferResult.ledgerTransactionId,
      senderNewAvailableBalance: transferResult.senderNewAvailableBalance
    };
  }

  /**
   * Revoga preventivamente um Código QR ativo emitido pelo utilizador.
   *
   * @param {object} actingUser
   * @param {string} qrTokenId
   * @param {object} [context={}]
   * @returns {Promise<{ message: string }>}
   */
  async revokeQrToken(actingUser, qrTokenId, context = {}) {
    const qrToken = await qrRepository.findById(qrTokenId);
    if (!qrToken) {
      throw NotFoundError.resource('Código QR', qrTokenId);
    }

    const revokeCheck = qrPolicy.canRevokeQrToken(actingUser, qrToken);
    if (!revokeCheck.allowed) {
      throw new AuthorizationError(revokeCheck.reason);
    }

    await qrRepository.revokeQrToken(qrTokenId);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'DELETE',
        resourceType: 'QR_TOKEN',
        resourceId: qrTokenId,
        metadata: {
          tokenCode: qrToken.token_code,
          revokedBy: actingUser.id
        }
      });
    }

    return {
      message: 'Código QR revogado com sucesso.'
    };
  }

  /**
   * Lista os Códigos QR ativos e históricos gerados pelo utilizador.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listUserQrTokens(actingUser, filters, paginationParams) {
    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await qrRepository.listUserQrTokens(actingUser.id, filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }
}

// Instância singleton do serviço de QR
const qrService = new QrService();

module.exports = qrService;