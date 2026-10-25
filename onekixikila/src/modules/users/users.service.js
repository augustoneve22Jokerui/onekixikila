const usersRepository = require('./users.repository');
const usersPolicy = require('./users.policy');
const authRepository = require('../auth/auth.repository');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const { queryOne } = require('../../database/query');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');

/**
 * Serviço de regras de negócio para a gestão de Utilizadores, Perfis e Governança Cadastral
 * na plataforma OneKixikila.
 */
class UsersService {
  /**
   * Consulta a ficha detalhada de um utilizador.
   * Aplica políticas de autorização estritas para impedir acesso indevido a dados pessoais (Anti-IDOR).
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} targetUserId - UUID do utilizador a consultar
   * @returns {Promise<object>}
   */
  async getProfile(actingUser, targetUserId) {
    if (!usersPolicy.canViewProfile(actingUser, targetUserId)) {
      throw AuthorizationError.forbiddenResource('Acesso não autorizado aos dados deste perfil.');
    }

    const user = await usersRepository.findById(targetUserId);
    if (!user) {
      throw NotFoundError.user(targetUserId);
    }

    return user;
  }

  /**
   * Consulta o perfil público higienizado de um utilizador para exibição em grupos e interações.
   *
   * @param {string} targetUserId
   * @returns {Promise<object>}
   */
  async getPublicProfile(targetUserId) {
    const profile = await usersRepository.getPublicProfile(targetUserId);
    if (!profile) {
      throw NotFoundError.user(targetUserId);
    }
    return profile;
  }

  /**
   * Atualiza os dados de cadastro e apresentação do perfil do utilizador.
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @param {object} profileData
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async updateProfile(actingUser, targetUserId, profileData, context = {}) {
    const policyResult = usersPolicy.canUpdateProfile(actingUser, targetUserId);
    if (!policyResult.allowed) {
      throw new AuthorizationError(policyResult.reason);
    }

    const userExists = await usersRepository.findById(targetUserId);
    if (!userExists) {
      throw NotFoundError.user(targetUserId);
    }

    const updatedProfile = await usersRepository.updateProfile(targetUserId, profileData);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'USER_PROFILE',
        resourceId: targetUserId,
        oldValues: {
          fullName: userExists.full_name,
          preferredName: userExists.preferred_name,
          province: userExists.province,
          municipality: userExists.municipality
        },
        newValues: profileData
      });
    }

    return updatedProfile;
  }

  /**
   * Atualiza as coordenadas de geolocalização e o consentimento de descoberta.
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @param {object} locationData
   * @returns {Promise<object>}
   */
  async updateLocation(actingUser, targetUserId, locationData) {
    const policyResult = usersPolicy.canUpdateProfile(actingUser, targetUserId);
    if (!policyResult.allowed) {
      throw new AuthorizationError(policyResult.reason);
    }

    const userExists = await usersRepository.findById(targetUserId);
    if (!userExists) {
      throw NotFoundError.user(targetUserId);
    }

    return usersRepository.updateLocation(targetUserId, locationData);
  }

  /**
   * Atualiza as preferências de notificação, idioma e moeda do utilizador.
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @param {object} preferencesData
   * @returns {Promise<object>}
   */
  async updatePreferences(actingUser, targetUserId, preferencesData) {
    const policyResult = usersPolicy.canUpdateProfile(actingUser, targetUserId);
    if (!policyResult.allowed) {
      throw new AuthorizationError(policyResult.reason);
    }

    const userExists = await usersRepository.findById(targetUserId);
    if (!userExists) {
      throw NotFoundError.user(targetUserId);
    }

    return usersRepository.updatePreferences(targetUserId, preferencesData);
  }

  /**
   * Altera o papel global do utilizador (Operação administrativa RBAC).
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @param {string} newRole
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async changeRole(actingUser, targetUserId, newRole, context = {}) {
    const policyResult = usersPolicy.canChangeUserRole(actingUser, targetUserId, newRole);
    if (!policyResult.allowed) {
      throw new AuthorizationError(policyResult.reason);
    }

    const targetUser = await usersRepository.findById(targetUserId);
    if (!targetUser) {
      throw NotFoundError.user(targetUserId);
    }

    const updated = await usersRepository.updateRole(targetUserId, newRole);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'ROLE_CHANGE',
        resourceType: 'USER',
        resourceId: targetUserId,
        oldValues: { role: targetUser.role },
        newValues: { role: newRole },
        metadata: { changedBy: actingUser.id }
      });
    }

    return updated;
  }

  /**
   * Altera o estado de uma conta (bloquear, suspender ou reativar) com justificativa.
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @param {string} newStatus
   * @param {string} reason
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async changeStatus(actingUser, targetUserId, newStatus, reason, context = {}) {
    const policyResult = usersPolicy.canChangeUserStatus(actingUser, targetUserId, newStatus);
    if (!policyResult.allowed) {
      throw new AuthorizationError(policyResult.reason);
    }

    const targetUser = await usersRepository.findById(targetUserId);
    if (!targetUser) {
      throw NotFoundError.user(targetUserId);
    }

    const updated = await usersRepository.updateStatus(targetUserId, newStatus);

    // Se a conta for suspensa ou bloqueada, revoga imediatamente todas as sessões ativas
    if (newStatus === 'BLOCKED' || newStatus === 'SUSPENDED') {
      await authRepository.revokeAllUserSessions(targetUserId, `ADMIN_ACTION_${newStatus}`);
    }

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'STATUS_CHANGE',
        resourceType: 'USER',
        resourceId: targetUserId,
        oldValues: { status: targetUser.status },
        newValues: { status: newStatus, reason },
        metadata: { changedBy: actingUser.id, reason }
      });
    }

    return updated;
  }

  /**
   * Solicita a desativação ou encerramento lógico (Soft Delete) de uma conta.
   * Impede o encerramento se o utilizador possuir obrigações ativas de Kixikila ou saldo na carteira.
   *
   * @param {object} actingUser
   * @param {string} targetUserId
   * @param {object} [context={}]
   * @returns {Promise<{ message: string }>}
   */
  async deactivateAccount(actingUser, targetUserId, context = {}) {
    const targetUser = await usersRepository.findById(targetUserId);
    if (!targetUser) {
      throw NotFoundError.user(targetUserId);
    }

    // 1. Apuração de saldo remanescente na carteira
    const walletSql = `SELECT ledger_balance, available_balance, locked_balance FROM wallets WHERE user_id = $1;`;
    const wallet = await queryOne(walletSql, [targetUserId]);

    // 2. Apuração de quotas pendentes em grupos de Kixikila
    const obligationsSql = `
      SELECT COUNT(*)::integer AS pending_count
      FROM contribution_obligations
      WHERE user_id = $1 AND status IN ('PENDING', 'LATE');
    `;
    const obligations = await queryOne(obligationsSql, [targetUserId]);

    const financialContext = {
      availableBalance: wallet ? Number(wallet.available_balance) : 0,
      lockedBalance: wallet ? Number(wallet.locked_balance) : 0,
      activeObligationsCount: obligations ? Number(obligations.pending_count) : 0
    };

    const policyResult = usersPolicy.canDeactivateAccount(actingUser, targetUser, financialContext);
    if (!policyResult.allowed) {
      throw new ConflictError(policyResult.reason, 'ACCOUNT_DEACTIVATION_BLOCKED');
    }

    await usersRepository.softDelete(targetUserId);
    await authRepository.revokeAllUserSessions(targetUserId, 'ACCOUNT_DEACTIVATED');

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'DELETE',
        resourceType: 'USER',
        resourceId: targetUserId,
        metadata: { deactivatedBy: actingUser.id }
      });
    }

    return {
      message: 'A sua conta foi desativada com sucesso. Os seus dados foram encerrados em conformidade regulatória.'
    };
  }

  /**
   * Consulta paginada e filtrada de contas para a equipa de administração e suporte.
   *
   * @param {object} actingUser
   * @param {object} filters
   * @param {object} paginationParams - { page, limit, offset }
   * @returns {Promise<object>}
   */
  async listUsers(actingUser, filters, paginationParams) {
    if (!usersPolicy.canListUsers(actingUser)) {
      throw AuthorizationError.insufficientPermissions(actingUser ? actingUser.role : 'ANONYMOUS', [
        'ADMIN',
        'SUPPORT_AGENT',
        'AUDITOR'
      ]);
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await usersRepository.listUsers(filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }
}

// Instância singleton do serviço de utilizadores
const usersService = new UsersService();

module.exports = usersService;