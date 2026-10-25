const adminRepository = require('./admin.repository');
const adminPolicy = require('./admin.policy');
const usersRepository = require('../users/users.repository');
const groupsRepository = require('../groups/groups.repository');
const leadershipRepository = require('../leadership/leadership.repository');
const membershipsRepository = require('../memberships/memberships.repository');
const authRepository = require('../auth/auth.repository');
const storageConfig = require('../../config/storage');
const paymentsConfig = require('../../config/payments');
const limitsConfig = require('../../config/limits');
const appConfig = require('../../config/app');
const { withTransaction } = require('../../database/transaction');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço de regras de negócio para Governança, Intervenção e Administração Geral
 * da plataforma OneKixikila.
 * Gerencia o painel executivo com métricas agregadas em tempo real, auditoria institucional,
 * supervisão cadastral de utilizadores, resolução de bloqueios e intervenção em grupos de Kixikila.
 */
class AdminService {
  /**
   * Obtém a visão geral e métricas consolidadas do painel executivo de administração.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @returns {Promise<object>}
   */
  async getDashboardOverview(actingUser) {
    const accessCheck = adminPolicy.canAccessAdminPanel(actingUser);
    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    return adminRepository.getDashboardOverview();
  }

  /**
   * Consulta os detalhes de auditoria técnica e cadastral de um utilizador específico.
   *
   * @param {object} actingUser
   * @param {string} userId - UUID do utilizador
   * @returns {Promise<object>}
   */
  async getUserDetails(actingUser, userId) {
    const accessCheck = adminPolicy.canAccessAdminPanel(actingUser);
    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    const userDetails = await adminRepository.findUserDetailsForAdmin(userId);
    if (!userDetails) {
      throw NotFoundError.user(userId);
    }

    return userDetails;
  }

  /**
   * Altera administrativamente o papel global (Role) de um utilizador.
   *
   * @param {object} actingUser
   * @param {string} userId
   * @param {string} newRole - Novo papel (ex: 'GROUP_LEADER', 'AUDITOR', 'ADMIN')
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async updateUserRole(actingUser, userId, newRole, context = {}) {
    const policyCheck = adminPolicy.canManageUserRole(actingUser, userId, newRole);
    if (!policyCheck.allowed) {
      throw new AuthorizationError(policyCheck.reason);
    }

    const targetUser = await usersRepository.findById(userId);
    if (!targetUser) {
      throw NotFoundError.user(userId);
    }

    if (targetUser.role === newRole) {
      return targetUser;
    }

    const updated = await usersRepository.updateRole(userId, newRole);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'ROLE_CHANGE',
        resourceType: 'USER',
        resourceId: userId,
        oldValues: { role: targetUser.role },
        newValues: { role: newRole },
        metadata: { managedByAdminId: actingUser.id }
      });
    }

    return updated;
  }

  /**
   * Altera o estado operacional de uma conta de utilizador (bloqueio, suspensão ou reativação).
   *
   * @param {object} actingUser
   * @param {string} userId
   * @param {string} status - 'ACTIVE', 'SUSPENDED', 'BLOCKED'
   * @param {string} reason - Justificativa administrativa formal
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async updateUserStatus(actingUser, userId, status, reason, context = {}) {
    const policyCheck = adminPolicy.canManageUserStatus(actingUser, userId, status);
    if (!policyCheck.allowed) {
      throw new AuthorizationError(policyCheck.reason);
    }

    const targetUser = await usersRepository.findById(userId);
    if (!targetUser) {
      throw NotFoundError.user(userId);
    }

    const updated = await withTransaction(async (client) => {
      const result = await usersRepository.updateStatus(userId, status, client);

      // Se for suspensão ou bloqueio, revoga imediatamente todas as sessões ativas
      if (status === 'BLOCKED' || status === 'SUSPENDED') {
        await authRepository.revokeAllUserSessions(userId, `ADMIN_SANCTION_${status}`, client);
      }

      return result;
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'STATUS_CHANGE',
        resourceType: 'USER',
        resourceId: userId,
        oldValues: { status: targetUser.status },
        newValues: { status, reason },
        metadata: { managedByAdminId: actingUser.id, reason }
      });
    }

    return updated;
  }

  /**
   * Consulta os dados cadastrais, regras e indicadores operacionais de um grupo para supervisão.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @returns {Promise<object>}
   */
  async getGroupDetails(actingUser, groupId) {
    const accessCheck = adminPolicy.canAccessAdminPanel(actingUser);
    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    const groupDetails = await adminRepository.findGroupDetailsForAdmin(groupId);
    if (!groupDetails) {
      throw NotFoundError.group(groupId);
    }

    return groupDetails;
  }

  /**
   * Altera administrativamente o estado operacional de um grupo (suspensão preventiva ou reativação).
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {string} newStatus - 'ACTIVE', 'PAUSED', 'SUSPENDED'
   * @param {string} reason
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async updateGroupStatus(actingUser, groupId, newStatus, reason, context = {}) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const policyCheck = adminPolicy.canSuperviseGroup(actingUser, group);
    if (!policyCheck.allowed) {
      throw new AuthorizationError(policyCheck.reason);
    }

    const updated = await adminRepository.updateGroupStatus(groupId, newStatus);

    eventBus.publish(
      newStatus === 'PAUSED' ? EVENT_TYPES.GROUP_PAUSED : EVENT_TYPES.GROUP_ACTIVATED,
      {
        groupId,
        status: newStatus,
        reason,
        managedBy: actingUser.id
      },
      { requestId: context.requestId }
    );

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'STATUS_CHANGE',
        resourceType: 'GROUP',
        resourceId: groupId,
        oldValues: { status: group.status },
        newValues: { status: newStatus, reason },
        metadata: { managedByAdminId: actingUser.id, reason }
      });
    }

    return updated;
  }

  /**
   * Substitui compulsoriamente a liderança de um grupo por deliberação administrativa de contingência.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {string} newLeaderId
   * @param {string} reason
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async forceChangeGroupLeader(actingUser, groupId, newLeaderId, reason, context = {}) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const policyCheck = adminPolicy.canSuperviseGroup(actingUser, group);
    if (!policyCheck.allowed) {
      throw new AuthorizationError(policyCheck.reason);
    }

    const newLeaderMembership = await membershipsRepository.findByGroupAndUser(groupId, newLeaderId);
    if (!newLeaderMembership || newLeaderMembership.status !== 'ACTIVE') {
      throw new ConflictError('O novo líder deve ser um membro com filiação ativa no grupo.');
    }

    await withTransaction(async (client) => {
      // 1. Atualiza o líder na tabela groups
      await groupsRepository.updateLeader(groupId, newLeaderId, client);

      // 2. Revoga mandatos anteriores de liderança titular
      await leadershipRepository.revokeActiveAssignmentsByRole(
        groupId,
        'PRIMARY_LEADER',
        {
          revokedBy: actingUser.id,
          reason: `INTERVENÇÃO_ADMINISTRATIVA: ${reason}`
        },
        client
      );

      // 3. Atribui a nova liderança formal
      await leadershipRepository.createAssignment(
        {
          groupId,
          userId: newLeaderId,
          leadershipRole: 'PRIMARY_LEADER',
          status: 'ACTIVE',
          assignedBy: actingUser.id
        },
        client
      );
    });

    eventBus.publish(
      EVENT_TYPES.GROUP_LEADERSHIP_TRANSFERRED,
      {
        groupId,
        previousLeaderId: group.leader_id,
        newLeaderId,
        forcedByAdmin: true
      },
      { requestId: context.requestId }
    );

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'GROUP_LEADERSHIP_INTERVENTION',
        resourceId: groupId,
        oldValues: { leaderId: group.leader_id },
        newValues: { leaderId: newLeaderId, reason },
        metadata: { managedByAdminId: actingUser.id }
      });
    }

    return {
      message: 'Liderança do grupo substituída por intervenção administrativa com sucesso.',
      groupId,
      newLeaderId
    };
  }

  /**
   * Consulta os registos de auditoria institucional (`audit_events`) com filtros e paginação.
   *
   * @param {object} actingUser
   * @param {object} filters - { action, resourceType, actorUserId, startDate, endDate }
   * @param {object} paginationParams - { page, limit, offset }
   * @returns {Promise<object>}
   */
  async listAuditLogs(actingUser, filters, paginationParams) {
    const policyCheck = adminPolicy.canViewAuditLogs(actingUser);
    if (!policyCheck.allowed) {
      throw new AuthorizationError(policyCheck.reason);
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await adminRepository.listAuditEvents(filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }

  /**
   * Lista grupos para a esteira administrativa com paginação e filtros de status.
   *
   * @param {object} actingUser
   * @param {object} filters - { status, frequency, search }
   * @param {object} paginationParams - { page, limit, offset }
   * @returns {Promise<object>}
   */
  async listGroups(actingUser, filters, paginationParams) {
    const accessCheck = adminPolicy.canAccessAdminPanel(actingUser);
    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await adminRepository.listGroupsForAdmin(filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }

  /**
   * Retorna os parâmetros operacionais e configurações vigentes da plataforma para o painel.
   *
   * @param {object} actingUser
   * @returns {Promise<object>}
   */
  async getSystemSettings(actingUser) {
    const accessCheck = adminPolicy.canAccessAdminPanel(actingUser);
    if (!accessCheck.allowed) {
      throw new AuthorizationError(accessCheck.reason);
    }

    return {
      environment: appConfig.env,
      appName: appConfig.name,
      currency: appConfig.currency,
      storage: {
        provider: storageConfig.provider,
        buckets: storageConfig.buckets,
        limits: storageConfig.limits
      },
      payments: {
        defaultCurrency: paymentsConfig.defaultCurrency,
        providers: Object.values(paymentsConfig.providers).map((p) => ({
          id: p.id,
          name: p.name,
          enabled: p.enabled,
          supportedChannels: p.supportedChannels
        }))
      },
      limits: {
        financialTiers: limitsConfig.financial.tiers,
        groups: limitsConfig.groups,
        uploads: limitsConfig.uploads
      }
    };
  }
}

// Instância singleton do serviço de administração
const adminService = new AdminService();

module.exports = adminService;