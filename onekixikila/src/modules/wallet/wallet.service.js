const walletRepository = require('./wallet.repository');
const walletPolicy = require('./wallet.policy');
const balanceManager = require('../../shared/finance/balance');
const Money = require('../../shared/finance/money');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço de regras de negócio para Gestão da Carteira Digital Interna (Wallet)
 * na plataforma OneKixikila.
 * Assegura o cumprimento inegociável da equação fundamental de saldos:
 *   available_balance + locked_balance = ledger_balance
 * e providencia extratos contábeis consolidados, recibos estruturados e governança de liquidez.
 */
class WalletService {
  /**
   * Consulta os dados cadastrais e saldos da carteira de um utilizador.
   * Aplica validação de titularidade Anti-IDOR e checagem da invariante contábil.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} targetUserId - UUID da conta a consultar
   * @returns {Promise<object>}
   */
  async getUserWallet(actingUser, targetUserId) {
    if (!walletPolicy.canViewWallet(actingUser, targetUserId)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado aos dados da carteira deste utilizador.');
    }

    const wallet = await walletRepository.findByUserId(targetUserId);
    if (!wallet) {
      throw NotFoundError.wallet(targetUserId);
    }

    // Valida a invariante contábil (available + locked = ledger)
    balanceManager.validateIntegrity(wallet);

    return {
      id: wallet.id,
      userId: wallet.user_id,
      currency: wallet.currency || 'AOA',
      status: wallet.status,
      ledgerBalance: Number(wallet.ledger_balance),
      availableBalance: Number(wallet.available_balance),
      lockedBalance: Number(wallet.locked_balance),
      formatted: {
        ledgerBalance: Money.of(wallet.ledger_balance, wallet.currency).format(),
        availableBalance: Money.of(wallet.available_balance, wallet.currency).format(),
        lockedBalance: Money.of(wallet.locked_balance, wallet.currency).format()
      },
      createdAt: wallet.created_at,
      updatedAt: wallet.updated_at
    };
  }

  /**
   * Consulta os dados de uma carteira pelo seu identificador primário UUID.
   *
   * @param {object} actingUser
   * @param {string} walletId
   * @returns {Promise<object>}
   */
  async getWalletById(actingUser, walletId) {
    const wallet = await walletRepository.findById(walletId);
    if (!wallet) {
      throw NotFoundError.resource('Carteira', walletId);
    }

    if (!walletPolicy.canViewWallet(actingUser, wallet.user_id)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado aos dados desta carteira.');
    }

    balanceManager.validateIntegrity(wallet);

    return {
      id: wallet.id,
      userId: wallet.user_id,
      currency: wallet.currency || 'AOA',
      status: wallet.status,
      ledgerBalance: Number(wallet.ledger_balance),
      availableBalance: Number(wallet.available_balance),
      lockedBalance: Number(wallet.locked_balance),
      formatted: {
        ledgerBalance: Money.of(wallet.ledger_balance, wallet.currency).format(),
        availableBalance: Money.of(wallet.available_balance, wallet.currency).format(),
        lockedBalance: Money.of(wallet.locked_balance, wallet.currency).format()
      },
      createdAt: wallet.created_at,
      updatedAt: wallet.updated_at
    };
  }

  /**
   * Consulta o extrato de lançamentos e movimentações da carteira com paginação e filtros.
   *
   * @param {object} actingUser
   * @param {string} walletId
   * @param {object} filters - { operationType, startDate, endDate }
   * @param {object} paginationParams - { limit, offset, page }
   * @returns {Promise<object>}
   */
  async getWalletStatement(actingUser, walletId, filters, paginationParams) {
    const wallet = await walletRepository.findById(walletId);
    if (!wallet) {
      throw NotFoundError.resource('Carteira', walletId);
    }

    if (!walletPolicy.canViewWallet(actingUser, wallet.user_id)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado ao extrato desta carteira.');
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await walletRepository.getStatement(walletId, filters, { limit, offset });

    const formattedRows = rows.map((row) => ({
      transactionId: row.transaction_id,
      referenceCode: row.reference_code,
      operationType: row.operation_type,
      direction: row.direction, // DEBIT ou CREDIT
      amount: Number(row.amount),
      currency: row.currency || 'AOA',
      formattedAmount: Money.of(row.amount, row.currency).format(),
      description: row.description,
      postedAt: row.posted_at,
      metadata: row.metadata || {}
    }));

    return formatPaginatedResult({
      data: formattedRows,
      totalCount,
      page,
      limit
    });
  }

  /**
   * Obtém o recibo ou comprovativo oficial estruturado de uma operação contábil.
   *
   * @param {object} actingUser
   * @param {string} transactionId
   * @returns {Promise<object>}
   */
  async getTransactionReceipt(actingUser, transactionId) {
    const receiptData = await walletRepository.getTransactionReceiptData(transactionId);
    if (!receiptData) {
      throw NotFoundError.resource('Recibo de Transação', transactionId);
    }

    if (!walletPolicy.canViewReceipt(actingUser, receiptData)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado ao comprovativo desta transação.');
    }

    const amountMoney = Money.of(receiptData.amount, receiptData.currency);

    return {
      receiptNumber: `REC-${receiptData.reference_code}`,
      referenceCode: receiptData.reference_code,
      operationType: receiptData.operation_type,
      status: receiptData.status,
      amount: Number(receiptData.amount),
      currency: receiptData.currency || 'AOA',
      formattedAmount: amountMoney.format(),
      description: receiptData.description,
      postedAt: receiptData.posted_at,
      counterparty: {
        userId: receiptData.user_id,
        fullName: receiptData.full_name || 'Utilizador OneKixikila'
      },
      metadata: receiptData.metadata || {}
    };
  }

  /**
   * Congela preventivamente a carteira de um utilizador por motivo de auditoria ou risco (Ação Administrativa).
   *
   * @param {object} actingUser - Administrador ou Auditor
   * @param {string} walletId
   * @param {string} reason
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async freezeWallet(actingUser, walletId, reason, context = {}) {
    const authCheck = walletPolicy.canManageWalletStatus(actingUser);
    if (!authCheck.allowed) {
      throw new AuthorizationError(authCheck.reason);
    }

    const wallet = await walletRepository.findById(walletId);
    if (!wallet) {
      throw NotFoundError.resource('Carteira', walletId);
    }

    if (wallet.status === 'FROZEN') {
      throw new ConflictError('A carteira informada já se encontra congelada.');
    }

    const updated = await walletRepository.updateStatus(walletId, 'FROZEN');

    eventBus.publish(EVENT_TYPES.WALLET_FROZEN, {
      walletId,
      userId: wallet.user_id,
      frozenBy: actingUser.id,
      reason
    }, { requestId: context.requestId });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'STATUS_CHANGE',
        resourceType: 'WALLET',
        resourceId: walletId,
        oldValues: { status: wallet.status },
        newValues: { status: 'FROZEN', reason, managedBy: actingUser.id }
      });
    }

    return updated;
  }

  /**
   * Descongela a carteira restabelecendo as operações normais de saldo (Ação Administrativa).
   *
   * @param {object} actingUser
   * @param {string} walletId
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async unfreezeWallet(actingUser, walletId, context = {}) {
    const authCheck = walletPolicy.canManageWalletStatus(actingUser);
    if (!authCheck.allowed) {
      throw new AuthorizationError(authCheck.reason);
    }

    const wallet = await walletRepository.findById(walletId);
    if (!wallet) {
      throw NotFoundError.resource('Carteira', walletId);
    }

    if (wallet.status !== 'FROZEN') {
      throw new ConflictError(`Apenas carteiras congeladas podem ser descongeladas. Estado atual: [${wallet.status}].`);
    }

    const updated = await walletRepository.updateStatus(walletId, 'ACTIVE');

    eventBus.publish(EVENT_TYPES.WALLET_UNFROZEN, {
      walletId,
      userId: wallet.user_id,
      unfrozenBy: actingUser.id
    }, { requestId: context.requestId });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'STATUS_CHANGE',
        resourceType: 'WALLET',
        resourceId: walletId,
        oldValues: { status: wallet.status },
        newValues: { status: 'ACTIVE', managedBy: actingUser.id }
      });
    }

    return updated;
  }

  /**
   * Lista as carteiras cadastradas para o painel de governança e auditoria financeira.
   *
   * @param {object} actingUser
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listWallets(actingUser, filters, paginationParams) {
    if (!walletPolicy.canAuditWallets(actingUser)) {
      throw AuthorizationError.insufficientPermissions(actingUser ? actingUser.role : 'ANONYMOUS', [
        'ADMIN',
        'AUDITOR',
        'FINANCIAL_OPERATOR'
      ]);
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await walletRepository.listWallets(filters, { limit, offset });

    const formattedRows = rows.map((w) => ({
      id: w.id,
      userId: w.user_id,
      userFullName: w.full_name,
      userEmail: w.email,
      currency: w.currency || 'AOA',
      status: w.status,
      ledgerBalance: Number(w.ledger_balance),
      availableBalance: Number(w.available_balance),
      lockedBalance: Number(w.locked_balance),
      createdAt: w.created_at
    }));

    return formatPaginatedResult({
      data: formattedRows,
      totalCount,
      page,
      limit
    });
  }
}

// Instância singleton do serviço de carteiras
const walletService = new WalletService();

module.exports = walletService;