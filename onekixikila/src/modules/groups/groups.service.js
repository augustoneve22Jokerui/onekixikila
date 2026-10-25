const groupsRepository = require('./groups.repository');
const groupsPolicy = require('./groups.policy');
const { withTransaction } = require('../../database/transaction');
const { queryOne, queryClient } = require('../../database/query');
const { generateSlug } = require('../../shared/security/sanitize');
const cryptoUtils = require('../../shared/utils/crypto');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');

/**
 * Serviço de regras de negócio para a gestão de Grupos de Kixikila,
 * regulamentos internos, ativação de ciclos e descoberta por proximidade geográfica.
 */
class GroupsService {
  /**
   * Cria atomicamente um novo grupo de Kixikila, o seu regulamento operacional,
   * a localização aproximada de descoberta e inscreve o criador como Líder titular ativo (Slot 1).
   *
   * @param {object} creatorUser - Utilizador autenticado (req.user)
   * @param {object} groupData - Dados validados pelo createGroupSchema
   * @param {object} [context={}]
   * @returns {Promise<object>} Ficha do grupo criado
   */
  async createGroup(creatorUser, groupData, context = {}) {
    // 1. Apuração de limites e verificação de elegibilidade KYC
    const countSql = `
      SELECT COUNT(*)::integer AS active_groups
      FROM groups
      WHERE leader_id = $1 AND status IN ('FORMATION', 'ACTIVE');
    `;
    const countRes = await queryOne(countSql, [creatorUser.id]);
    const activeGroupsCount = countRes ? countRes.active_groups : 0;
    const userTier = creatorUser.identity_tier || 'TIER_1_UNVERIFIED';

    const policyResult = groupsPolicy.canCreateGroup(creatorUser, activeGroupsCount, userTier);
    if (!policyResult.allowed) {
      throw new ConflictError(policyResult.reason, 'GROUP_CREATION_LIMIT_EXCEEDED');
    }

    // 2. Geração e garantia de unicidade do slug de URL
    let baseSlug = generateSlug(groupData.name);
    if (!baseSlug || baseSlug.length < 3) {
      baseSlug = `kixikila-${cryptoUtils.randomHex(4)}`;
    }

    let slug = baseSlug;
    const isTaken = await groupsRepository.isSlugTaken(slug);
    if (isTaken) {
      slug = `${baseSlug}-${cryptoUtils.randomHex(3)}`;
    }

    // 3. Execução transacional atómica da criação no PostgreSQL
    const created = await withTransaction(async (client) => {
      // Inserção em groups
      const group = await groupsRepository.createGroup(
        {
          creatorId: creatorUser.id,
          leaderId: creatorUser.id,
          name: groupData.name,
          slug,
          description: groupData.description,
          frequency: groupData.frequency,
          contributionAmount: groupData.contributionAmount,
          minMembers: groupData.minMembers,
          maxMembers: groupData.maxMembers,
          startDate: groupData.startDate,
          isPrivate: groupData.isPrivate,
          allowAutoDebit: groupData.allowAutoDebit
        },
        client
      );

      // Inserção em group_rules
      const rulesData = groupData.rules || {};
      const rules = await groupsRepository.createGroupRules(
        {
          groupId: group.id,
          rotationType: rulesData.rotationType,
          gracePeriodDays: rulesData.gracePeriodDays,
          lateFeeType: rulesData.lateFeeType,
          lateFeeValue: rulesData.lateFeeValue,
          allowEarlyPayout: rulesData.allowEarlyPayout,
          requireAdminApprovalToJoin: rulesData.requireAdminApprovalToJoin,
          requireIdentityVerification: rulesData.requireIdentityVerification,
          termsAndConditions: rulesData.termsAndConditions
        },
        client
      );

      // Inserção em group_locations
      let location = null;
      if (groupData.location) {
        location = await groupsRepository.createGroupLocation(
          {
            groupId: group.id,
            province: groupData.location.province,
            municipality: groupData.location.municipality,
            neighborhood: groupData.location.neighborhood,
            approximateLatitude: groupData.location.approximateLatitude,
            approximateLongitude: groupData.location.approximateLongitude,
            radiusMeters: groupData.location.radiusMeters,
            isPubliclyDiscoverable: groupData.location.isPubliclyDiscoverable
          },
          client
        );
      }

      // Filiação do Líder Fundador com status ACTIVE no slot número 1
      const membershipSql = `
        INSERT INTO group_memberships (
          group_id,
          user_id,
          role,
          status,
          joined_at,
          approved_by,
          approved_at,
          slot_number
        )
        VALUES ($1, $2, 'VICE_LEADER', 'ACTIVE', NOW() AT TIME ZONE 'UTC', $2, NOW() AT TIME ZONE 'UTC', 1)
        RETURNING id;
      `;
      await queryClient(client, membershipSql, [group.id, creatorUser.id]);

      // Registo formal da atribuição de liderança
      const leadershipSql = `
        INSERT INTO leadership_assignments (
          group_id,
          user_id,
          leadership_role,
          status,
          assigned_by,
          assigned_at
        )
        VALUES ($1, $2, 'PRIMARY_LEADER', 'ACTIVE', $2, NOW() AT TIME ZONE 'UTC');
      `;
      await queryClient(client, leadershipSql, [group.id, creatorUser.id]);

      // Emissão do evento de criação do grupo
      eventBus.publish(
        EVENT_TYPES.GROUP_CREATED,
        {
          groupId: group.id,
          name: group.name,
          slug: group.slug,
          creatorId: creatorUser.id,
          contributionAmount: group.contribution_amount,
          frequency: group.frequency
        },
        { requestId: context.requestId }
      );

      return {
        ...group,
        rules,
        location,
        active_members_count: 1
      };
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'CREATE',
        resourceType: 'GROUP',
        resourceId: created.id,
        metadata: {
          name: created.name,
          slug: created.slug,
          frequency: created.frequency,
          contributionAmount: created.contribution_amount
        }
      });
    }

    return created;
  }

  /**
   * Consulta a ficha completa de um grupo pelo seu UUID.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @returns {Promise<object>}
   */
  async getGroupById(actingUser, groupId) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    let isMember = false;
    if (actingUser) {
      const memberCheckSql = `
        SELECT 1 FROM group_memberships
        WHERE group_id = $1 AND user_id = $2 AND status = 'ACTIVE'
        LIMIT 1;
      `;
      const memberRes = await queryOne(memberCheckSql, [groupId, actingUser.id]);
      isMember = Boolean(memberRes);
    }

    if (!groupsPolicy.canViewGroup(actingUser, group, isMember)) {
      throw AuthorizationError.forbiddenResource('Este grupo de Kixikila é privado e restrito aos seus membros.');
    }

    return {
      ...group,
      isCurrentUserMember: isMember
    };
  }

  /**
   * Consulta a ficha de um grupo pelo seu slug textual de URL.
   *
   * @param {object} actingUser
   * @param {string} slug
   * @returns {Promise<object>}
   */
  async getGroupBySlug(actingUser, slug) {
    const group = await groupsRepository.findBySlug(slug);
    if (!group) {
      throw NotFoundError.group(slug);
    }

    let isMember = false;
    if (actingUser) {
      const memberCheckSql = `
        SELECT 1 FROM group_memberships
        WHERE group_id = $1 AND user_id = $2 AND status = 'ACTIVE'
        LIMIT 1;
      `;
      const memberRes = await queryOne(memberCheckSql, [group.id, actingUser.id]);
      isMember = Boolean(memberRes);
    }

    if (!groupsPolicy.canViewGroup(actingUser, group, isMember)) {
      throw AuthorizationError.forbiddenResource('Este grupo de Kixikila é privado e restrito aos seus membros.');
    }

    return {
      ...group,
      isCurrentUserMember: isMember
    };
  }

  /**
   * Atualiza dados cadastrais descritivos do grupo.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {object} updateData
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async updateGroup(actingUser, groupId, updateData, context = {}) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const manageCheck = groupsPolicy.canManageGroup(actingUser, group);
    if (!manageCheck.allowed) {
      throw new AuthorizationError(manageCheck.reason);
    }

    const updated = await groupsRepository.updateGroup(groupId, updateData);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'GROUP',
        resourceId: groupId,
        oldValues: { name: group.name, description: group.description },
        newValues: updateData
      });
    }

    return updated;
  }

  /**
   * Atualiza o regulamento interno e regras de rotação do grupo (permitido apenas antes da ativação).
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {object} rulesData
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async updateRules(actingUser, groupId, rulesData, context = {}) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const rulesCheck = groupsPolicy.canUpdateRules(actingUser, group);
    if (!rulesCheck.allowed) {
      throw new ConflictError(rulesCheck.reason, 'RULES_UPDATE_BLOCKED');
    }

    const updatedRules = await groupsRepository.updateGroupRules(groupId, rulesData);

    eventBus.publish(EVENT_TYPES.GROUP_RULES_UPDATED, {
      groupId,
      updatedBy: actingUser.id
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'GROUP_RULES',
        resourceId: groupId,
        newValues: rulesData
      });
    }

    return updatedRules;
  }

  /**
   * Atualiza as coordenadas e a localização territorial de descoberta do grupo.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {object} locationData
   * @returns {Promise<object>}
   */
  async updateLocation(actingUser, groupId, locationData) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const manageCheck = groupsPolicy.canManageGroup(actingUser, group);
    if (!manageCheck.allowed) {
      throw new AuthorizationError(manageCheck.reason);
    }

    return groupsRepository.updateGroupLocation(groupId, locationData);
  }

  /**
   * Ativa formalmente o grupo de Kixikila para início das quotas e rotações financeiras.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async activateGroup(actingUser, groupId, context = {}) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const manageCheck = groupsPolicy.canManageGroup(actingUser, group);
    if (!manageCheck.allowed) {
      throw new AuthorizationError(manageCheck.reason);
    }

    const activeCount = Number(group.active_members_count) || 0;
    const activationCheck = groupsPolicy.canActivateGroup(group, activeCount);
    if (!activationCheck.allowed) {
      throw new ConflictError(activationCheck.reason, 'ACTIVATION_CRITERIA_NOT_MET');
    }

    const updated = await groupsRepository.updateStatus(groupId, 'ACTIVE');

    eventBus.publish(EVENT_TYPES.GROUP_ACTIVATED, {
      groupId,
      activatedBy: actingUser.id,
      totalMembers: activeCount
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'STATUS_CHANGE',
        resourceType: 'GROUP',
        resourceId: groupId,
        oldValues: { status: group.status },
        newValues: { status: 'ACTIVE' }
      });
    }

    return updated;
  }

  /**
   * Pausa temporariamente as operações do grupo (ex: em caso de disputa grave).
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {string} reason
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async pauseGroup(actingUser, groupId, reason, context = {}) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const manageCheck = groupsPolicy.canManageGroup(actingUser, group);
    if (!manageCheck.allowed) {
      throw new AuthorizationError(manageCheck.reason);
    }

    if (group.status !== 'ACTIVE') {
      throw new ConflictError(`Apenas grupos ativos podem ser pausados. Estado atual: [${group.status}].`);
    }

    const updated = await groupsRepository.updateStatus(groupId, 'PAUSED');

    eventBus.publish(EVENT_TYPES.GROUP_PAUSED, {
      groupId,
      pausedBy: actingUser.id,
      reason
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'STATUS_CHANGE',
        resourceType: 'GROUP',
        resourceId: groupId,
        oldValues: { status: group.status },
        newValues: { status: 'PAUSED', reason }
      });
    }

    return updated;
  }

  /**
   * Transfere formalmente a liderança do grupo para outro membro ativo.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {string} newLeaderId
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async changeLeader(actingUser, groupId, newLeaderId, context = {}) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const manageCheck = groupsPolicy.canManageGroup(actingUser, group);
    if (!manageCheck.allowed) {
      throw new AuthorizationError(manageCheck.reason);
    }

    // Valida se o novo líder é membro ativo do grupo
    const membershipSql = `
      SELECT id, role, status FROM group_memberships
      WHERE group_id = $1 AND user_id = $2 AND status = 'ACTIVE'
      LIMIT 1;
    `;
    const newLeaderMembership = await queryOne(membershipSql, [groupId, newLeaderId]);
    if (!newLeaderMembership) {
      throw new ConflictError('O novo líder deve ser um membro com filiação ativa no grupo.');
    }

    await withTransaction(async (client) => {
      // 1. Atualiza o leader_id no grupo
      await groupsRepository.updateLeader(groupId, newLeaderId, client);

      // 2. Revoga a atribuição de liderança anterior
      await client.query(
        `UPDATE leadership_assignments
         SET status = 'REVOKED',
             revoked_at = NOW() AT TIME ZONE 'UTC',
             revoked_by = $1,
             revocation_reason = 'LEADERSHIP_TRANSFERRED'
         WHERE group_id = $2 AND status = 'ACTIVE';`,
        [actingUser.id, groupId]
      );

      // 3. Insere a nova atribuição formal
      await client.query(
        `INSERT INTO leadership_assignments (
           group_id, user_id, leadership_role, status, assigned_by, assigned_at
         )
         VALUES ($1, $2, 'PRIMARY_LEADER', 'ACTIVE', $3, NOW() AT TIME ZONE 'UTC');`,
        [groupId, newLeaderId, actingUser.id]
      );
    });

    eventBus.publish(EVENT_TYPES.GROUP_LEADERSHIP_TRANSFERRED, {
      groupId,
      previousLeaderId: group.leader_id,
      newLeaderId
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'GROUP_LEADER',
        resourceId: groupId,
        oldValues: { leaderId: group.leader_id },
        newValues: { leaderId: newLeaderId }
      });
    }

    return {
      message: 'Liderança do grupo transferida com sucesso.',
      newLeaderId
    };
  }

  /**
   * Catálogo paginado e filtrado de grupos para descoberta pública ou navegação.
   *
   * @param {object} actingUser
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listGroups(actingUser, filters, paginationParams) {
    const { limit, offset, page } = paginationParams;

    // Utilizadores não-administradores só consultam grupos públicos ou em formação/ativos
    const safeFilters = {
      ...filters,
      isPrivate: filters.isPrivate !== undefined ? filters.isPrivate : false
    };

    const { rows, totalCount } = await groupsRepository.listGroups(safeFilters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }

  /**
   * Pesquisa de grupos públicos próximos por geolocalização do dispositivo.
   *
   * @param {object} actingUser
   * @param {object} params - { latitude, longitude, radiusMeters, limit, offset, page }
   * @returns {Promise<object>}
   */
  async findNearbyGroups(actingUser, params) {
    const { latitude, longitude, radiusMeters = 10000, limit = 20, offset = 0, page = 1 } = params;

    const rows = await groupsRepository.findNearbyGroups({
      latitude,
      longitude,
      radiusMeters,
      limit,
      offset
    });

    return {
      data: rows,
      searchCenter: { latitude, longitude, radiusMeters },
      pagination: {
        currentPage: page,
        pageSize: limit,
        resultsCount: rows.length
      }
    };
  }
}

// Instância singleton do serviço de grupos
const groupsService = new GroupsService();

module.exports = groupsService;