const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para a tabela `group_memberships`.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para gestão de adesões,
 * aprovação e rejeição de membros, atribuição de vagas/turnos (slots), restrições cautelares e papéis internos.
 */
class MembershipsRepository {
  /**
   * Insere um novo pedido ou registo de filiação em group_memberships.
   *
   * @param {object} params
   * @param {string} params.groupId - UUID do grupo de Kixikila
   * @param {string} params.userId - UUID do utilizador
   * @param {string} [params.role='MEMBER'] - 'MEMBER', 'VICE_LEADER', 'TREASURER', 'SECRETARY'
   * @param {string} [params.status='PENDING_APPROVAL'] - 'PENDING_APPROVAL', 'ACTIVE', etc.
   * @param {number|null} [params.slotNumber] - Posição/ordem atribuída na rotação
   * @param {string|null} [params.approvedBy] - UUID do líder aprovador
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async createMembership(params, client = null) {
    const {
      groupId,
      userId,
      role = 'MEMBER',
      status = 'PENDING_APPROVAL',
      slotNumber = null,
      approvedBy = null
    } = params;

    const isApproved = status === 'ACTIVE';
    const text = `
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;

    const values = [
      groupId,
      userId,
      role,
      status,
      isApproved ? new Date() : null,
      approvedBy,
      isApproved ? new Date() : null,
      slotNumber
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza uma filiação pelo seu identificador primário UUID, trazendo dados do utilizador e perfil.
   *
   * @param {string} membershipId
   * @param {import('pg').PoolClient} [client]
   */
  async findById(membershipId, client = null) {
    const text = `
      SELECT 
        gm.id,
        gm.group_id,
        gm.user_id,
        gm.role,
        gm.status,
        gm.joined_at,
        gm.approved_by,
        gm.approved_at,
        gm.suspension_reason,
        gm.suspended_until,
        gm.left_at,
        gm.is_banned_from_chat,
        gm.is_contribution_restricted,
        gm.is_payout_restricted,
        gm.slot_number,
        gm.created_at,
        gm.updated_at,
        u.email,
        u.phone_number,
        p.full_name,
        p.preferred_name,
        p.avatar_url,
        g.name AS group_name,
        g.leader_id,
        g.status AS group_status
      FROM group_memberships gm
      INNER JOIN groups g ON g.id = gm.group_id
      INNER JOIN users u ON u.id = gm.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE gm.id = $1;
    `;

    return client ? queryOneClient(client, text, [membershipId]) : queryOne(text, [membershipId]);
  }

  /**
   * Localiza a filiação existente entre determinado utilizador e grupo.
   *
   * @param {string} groupId
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   */
  async findByGroupAndUser(groupId, userId, client = null) {
    const text = `
      SELECT 
        gm.id,
        gm.group_id,
        gm.user_id,
        gm.role,
        gm.status,
        gm.joined_at,
        gm.approved_by,
        gm.approved_at,
        gm.is_banned_from_chat,
        gm.is_contribution_restricted,
        gm.is_payout_restricted,
        gm.slot_number,
        g.leader_id,
        (g.leader_id = gm.user_id) AS is_primary_leader
      FROM group_memberships gm
      INNER JOIN groups g ON g.id = gm.group_id
      WHERE gm.group_id = $1 AND gm.user_id = $2;
    `;

    return client ? queryOneClient(client, text, [groupId, userId]) : queryOne(text, [groupId, userId]);
  }

  /**
   * Atualiza o estado da filiação (ex: aprovação, suspensão, saída voluntária ou expulsão).
   *
   * @param {string} membershipId
   * @param {string} status - 'ACTIVE', 'SUSPENDED', 'LEFT', 'EXPELLED', etc.
   * @param {object} [extraFields={}] - { approvedBy, suspensionReason, suspendedUntil, slotNumber }
   * @param {import('pg').PoolClient} [client]
   */
  async updateStatus(membershipId, status, extraFields = {}, client = null) {
    const fields = ['status = $1', 'updated_at = NOW() AT TIME ZONE \'UTC\''];
    const values = [status];
    let paramIndex = 2;

    if (status === 'ACTIVE') {
      fields.push(`approved_at = NOW() AT TIME ZONE 'UTC'`);
      fields.push(`joined_at = COALESCE(joined_at, NOW() AT TIME ZONE 'UTC')`);
      if (extraFields.approvedBy) {
        fields.push(`approved_by = $${paramIndex}`);
        values.push(extraFields.approvedBy);
        paramIndex += 1;
      }
      if (extraFields.slotNumber !== undefined) {
        fields.push(`slot_number = $${paramIndex}`);
        values.push(extraFields.slotNumber);
        paramIndex += 1;
      }
    } else if (status === 'SUSPENDED') {
      fields.push(`suspension_reason = $${paramIndex}`);
      values.push(extraFields.suspensionReason || 'Suspensão preventiva');
      paramIndex += 1;

      if (extraFields.suspendedUntil) {
        fields.push(`suspended_until = $${paramIndex}`);
        values.push(extraFields.suspendedUntil);
        paramIndex += 1;
      }
    } else if (status === 'LEFT' || status === 'EXPELLED') {
      fields.push(`left_at = NOW() AT TIME ZONE 'UTC'`);
    }

    values.push(membershipId);
    const text = `
      UPDATE group_memberships
      SET ${fields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *;
    `;

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Atualiza o papel funcional do membro dentro do grupo (ex: VICE_LEADER, TREASURER).
   *
   * @param {string} membershipId
   * @param {string} newRole
   * @param {import('pg').PoolClient} [client]
   */
  async updateRole(membershipId, newRole, client = null) {
    const text = `
      UPDATE group_memberships
      SET role = $1,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2
      RETURNING id, role, updated_at;
    `;

    return client ? queryOneClient(client, text, [newRole, membershipId]) : queryOne(text, [newRole, membershipId]);
  }

  /**
   * Atualiza restrições operacionais pontuais (bloqueio de chat, quota ou recebimento).
   *
   * @param {string} membershipId
   * @param {object} restrictions - { isBannedFromChat, isContributionRestricted, isPayoutRestricted }
   * @param {import('pg').PoolClient} [client]
   */
  async updateRestrictions(membershipId, restrictions, client = null) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    if (restrictions.isBannedFromChat !== undefined) {
      fields.push(`is_banned_from_chat = $${paramIndex}`);
      values.push(restrictions.isBannedFromChat);
      paramIndex += 1;
    }

    if (restrictions.isContributionRestricted !== undefined) {
      fields.push(`is_contribution_restricted = $${paramIndex}`);
      values.push(restrictions.isContributionRestricted);
      paramIndex += 1;
    }

    if (restrictions.isPayoutRestricted !== undefined) {
      fields.push(`is_payout_restricted = $${paramIndex}`);
      values.push(restrictions.isPayoutRestricted);
      paramIndex += 1;
    }

    if (fields.length === 0) {
      return this.findById(membershipId, client);
    }

    fields.push('updated_at = NOW() AT TIME ZONE \'UTC\'');
    values.push(membershipId);

    const text = `
      UPDATE group_memberships
      SET ${fields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *;
    `;

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Lista todos os membros de um grupo com filtros opcionais de estado e ordenação por vaga/turno.
   *
   * @param {string} groupId
   * @param {object} [filters={}]
   * @param {import('pg').PoolClient} [client]
   */
  async listMembersByGroup(groupId, filters = {}, client = null) {
    const conditions = ['gm.group_id = $1'];
    const values = [groupId];
    let paramIndex = 2;

    if (filters.status) {
      conditions.push(`gm.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex += 1;
    }

    if (filters.role) {
      conditions.push(`gm.role = $${paramIndex}`);
      values.push(filters.role);
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    const text = `
      SELECT 
        gm.id AS membership_id,
        gm.user_id,
        gm.role,
        gm.status,
        gm.slot_number,
        gm.joined_at,
        gm.is_banned_from_chat,
        gm.is_contribution_restricted,
        gm.is_payout_restricted,
        u.email,
        u.phone_number,
        p.full_name,
        p.preferred_name,
        p.avatar_url,
        (g.leader_id = gm.user_id) AS is_leader
      FROM group_memberships gm
      INNER JOIN groups g ON g.id = gm.group_id
      INNER JOIN users u ON u.id = gm.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE ${whereClause}
      ORDER BY 
        CASE WHEN gm.slot_number IS NOT NULL THEN gm.slot_number ELSE 9999 END ASC,
        gm.created_at ASC;
    `;

    const result = client ? await queryClient(client, text, values) : await query(text, values);
    return result.rows;
  }

  /**
   * Lista todos os grupos aos quais determinado utilizador pertence.
   *
   * @param {string} userId
   * @param {object} [filters={}]
   * @param {import('pg').PoolClient} [client]
   */
  async listUserMemberships(userId, filters = {}, client = null) {
    const conditions = ['gm.user_id = $1'];
    const values = [userId];
    let paramIndex = 2;

    if (filters.status) {
      conditions.push(`gm.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    const text = `
      SELECT 
        gm.id AS membership_id,
        gm.role,
        gm.status AS membership_status,
        gm.slot_number,
        gm.joined_at,
        g.id AS group_id,
        g.name AS group_name,
        g.slug AS group_slug,
        g.status AS group_status,
        g.frequency,
        g.contribution_amount,
        g.currency,
        g.leader_id,
        (g.leader_id = gm.user_id) AS is_leader
      FROM group_memberships gm
      INNER JOIN groups g ON g.id = gm.group_id
      WHERE ${whereClause}
      ORDER BY gm.created_at DESC;
    `;

    const result = client ? await queryClient(client, text, values) : await query(text, values);
    return result.rows;
  }

  /**
   * Calcula o próximo número de vaga/turno livre (Slot) na rotação do grupo.
   *
   * @param {string} groupId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<number>}
   */
  async getNextAvailableSlot(groupId, client = null) {
    const text = `
      SELECT COALESCE(MAX(slot_number), 0) + 1 AS next_slot
      FROM group_memberships
      WHERE group_id = $1 AND status = 'ACTIVE';
    `;

    const result = client ? await queryOneClient(client, text, [groupId]) : await queryOne(text, [groupId]);
    return result ? result.next_slot : 1;
  }

  /**
   * Exclui o registo de filiação (utilizado para rejeições de adesão pendente).
   *
   * @param {string} membershipId
   * @param {import('pg').PoolClient} [client]
   */
  async deleteMembership(membershipId, client = null) {
    const text = `
      DELETE FROM group_memberships
      WHERE id = $1
      RETURNING id, group_id, user_id;
    `;

    return client ? queryOneClient(client, text, [membershipId]) : queryOne(text, [membershipId]);
  }
}

// Instância singleton do repositório de filiações
const membershipsRepository = new MembershipsRepository();

module.exports = membershipsRepository;