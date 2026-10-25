const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para a tabela `group_invitations`.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para geração de convites,
 * validação de quotas de utilização (`used_count <= max_uses`), verificação de códigos e revogação.
 */
class InvitationsRepository {
  /**
   * Insere um novo registo de convite na tabela group_invitations.
   *
   * @param {object} params
   * @param {string} params.groupId - UUID do grupo de Kixikila
   * @param {string} params.invitedBy - UUID do líder ou membro emissor
   * @param {string} params.inviteCode - Código aleatório único
   * @param {string} [params.channel='DIRECT_LINK'] - 'DIRECT_LINK', 'QR_CODE', 'SMS', 'EMAIL', 'MANUAL_CODE'
   * @param {string|null} [params.invitedPhone]
   * @param {string|null} [params.invitedEmail]
   * @param {string|null} [params.invitedUserId]
   * @param {number} [params.maxUses=1]
   * @param {Date} params.expiresAt
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async createInvitation(params, client = null) {
    const {
      groupId,
      invitedBy,
      inviteCode,
      channel = 'DIRECT_LINK',
      invitedPhone = null,
      invitedEmail = null,
      invitedUserId = null,
      maxUses = 1,
      expiresAt
    } = params;

    const text = `
      INSERT INTO group_invitations (
        group_id,
        invited_by,
        invite_code,
        channel,
        invited_phone,
        invited_email,
        invited_user_id,
        status,
        max_uses,
        used_count,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, 0, $9)
      RETURNING *;
    `;

    const values = [
      groupId,
      invitedBy,
      inviteCode,
      channel,
      invitedPhone,
      invitedEmail,
      invitedUserId,
      maxUses,
      expiresAt
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza um convite pelo seu identificador UUID, unindo dados básicos do grupo.
   *
   * @param {string} invitationId
   * @param {import('pg').PoolClient} [client]
   */
  async findById(invitationId, client = null) {
    const text = `
      SELECT 
        gi.id,
        gi.group_id,
        gi.invited_by,
        gi.invite_code,
        gi.channel,
        gi.invited_phone,
        gi.invited_email,
        gi.invited_user_id,
        gi.status,
        gi.max_uses,
        gi.used_count,
        gi.expires_at,
        gi.accepted_at,
        gi.created_at,
        gi.updated_at,
        g.name AS group_name,
        g.slug AS group_slug,
        g.leader_id,
        g.status AS group_status,
        g.contribution_amount,
        g.currency,
        p.full_name AS inviter_name
      FROM group_invitations gi
      INNER JOIN groups g ON g.id = gi.group_id
      INNER JOIN users u ON u.id = gi.invited_by
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE gi.id = $1;
    `;

    return client ? queryOneClient(client, text, [invitationId]) : queryOne(text, [invitationId]);
  }

  /**
   * Localiza um convite pelo seu código alfanumérico único.
   *
   * @param {string} inviteCode
   * @param {import('pg').PoolClient} [client]
   */
  async findByCode(inviteCode, client = null) {
    const text = `
      SELECT 
        gi.id,
        gi.group_id,
        gi.invited_by,
        gi.invite_code,
        gi.channel,
        gi.invited_phone,
        gi.invited_email,
        gi.invited_user_id,
        gi.status,
        gi.max_uses,
        gi.used_count,
        gi.expires_at,
        gi.accepted_at,
        g.name AS group_name,
        g.slug AS group_slug,
        g.leader_id,
        g.status AS group_status,
        g.frequency,
        g.contribution_amount,
        g.currency,
        g.min_members,
        g.max_members,
        p.full_name AS inviter_name
      FROM group_invitations gi
      INNER JOIN groups g ON g.id = gi.group_id
      INNER JOIN users u ON u.id = gi.invited_by
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE gi.invite_code = $1;
    `;

    return client ? queryOneClient(client, text, [inviteCode]) : queryOne(text, [inviteCode]);
  }

  /**
   * Incrementa a contagem de utilizações do convite e conclui formalmente o estado se atingir o teto.
   *
   * @param {string} invitationId
   * @param {import('pg').PoolClient} [client]
   */
  async incrementUsage(invitationId, client = null) {
    const text = `
      UPDATE group_invitations
      SET used_count = used_count + 1,
          status = CASE WHEN used_count + 1 >= max_uses THEN 'ACCEPTED'::invitation_status ELSE status END,
          accepted_at = CASE WHEN used_count + 1 >= max_uses THEN NOW() AT TIME ZONE 'UTC' ELSE accepted_at END,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $1
      RETURNING id, group_id, status, max_uses, used_count, accepted_at;
    `;

    return client ? queryOneClient(client, text, [invitationId]) : queryOne(text, [invitationId]);
  }

  /**
   * Revoga formalmente um convite pendente.
   *
   * @param {string} invitationId
   * @param {import('pg').PoolClient} [client]
   */
  async revokeInvitation(invitationId, client = null) {
    const text = `
      UPDATE group_invitations
      SET status = 'REVOKED',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $1
      RETURNING id, status, updated_at;
    `;

    return client ? queryOneClient(client, text, [invitationId]) : queryOne(text, [invitationId]);
  }

  /**
   * Lista convites emitidos para determinado grupo com filtros e paginação.
   *
   * @param {string} groupId
   * @param {object} [filters={}]
   * @param {object} [pagination={ limit: 20, offset: 0 }]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<{ rows: Array<any>, totalCount: number }>}
   */
  async listGroupInvitations(groupId, filters = {}, pagination = { limit: 20, offset: 0 }, client = null) {
    const conditions = ['gi.group_id = $1'];
    const values = [groupId];
    let paramIndex = 2;

    if (filters.status) {
      conditions.push(`gi.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex += 1;
    }

    if (filters.channel) {
      conditions.push(`gi.channel = $${paramIndex}`);
      values.push(filters.channel);
      paramIndex += 1;
    }

    const whereClause = conditions.join(' AND ');

    // Contagem total
    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM group_invitations gi
      WHERE ${whereClause};
    `;
    const countResult = client ? await queryOneClient(client, countSql, values) : await queryOne(countSql, values);
    const totalCount = countResult ? countResult.total : 0;

    // Registos paginados
    values.push(pagination.limit);
    const limitParam = `$${paramIndex}`;
    paramIndex += 1;

    values.push(pagination.offset);
    const offsetParam = `$${paramIndex}`;

    const dataSql = `
      SELECT 
        gi.id,
        gi.invite_code,
        gi.channel,
        gi.invited_phone,
        gi.invited_email,
        gi.status,
        gi.max_uses,
        gi.used_count,
        gi.expires_at,
        gi.created_at,
        p.full_name AS inviter_name
      FROM group_invitations gi
      INNER JOIN users u ON u.id = gi.invited_by
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE ${whereClause}
      ORDER BY gi.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;

    const dataResult = client ? await queryClient(client, dataSql, values) : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }

  /**
   * Consulta convites direcionados especificamente a determinado número de telemóvel angolano.
   *
   * @param {string} phone
   * @param {import('pg').PoolClient} [client]
   */
  async findPendingByPhone(phone, client = null) {
    const text = `
      SELECT gi.*, g.name AS group_name, g.slug AS group_slug
      FROM group_invitations gi
      INNER JOIN groups g ON g.id = gi.group_id
      WHERE gi.invited_phone = $1
        AND gi.status = 'PENDING'
        AND gi.expires_at > (NOW() AT TIME ZONE 'UTC')
      ORDER BY gi.created_at DESC;
    `;

    const result = client ? await queryClient(client, text, [phone]) : await query(text, [phone]);
    return result.rows;
  }
}

// Instância singleton do repositório de convites
const invitationsRepository = new InvitationsRepository();

module.exports = invitationsRepository;