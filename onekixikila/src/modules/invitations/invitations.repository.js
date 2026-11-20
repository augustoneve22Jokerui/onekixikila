// =============================================================================
// modules/invitations/invitations.repository.js
// =============================================================================

const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');
const ConflictError = require('../../shared/errors/conflict-error');

/**
 * Repositório de persistência SQL para a tabela `group_invitations`.
 */
class InvitationsRepository {
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
   * Consome uma utilização do convite de forma atómica.
   *
   * A condição no UPDATE faz com que pedidos simultâneos não ultrapassem
   * max_uses. Se o convite já não puder ser consumido, lança um erro para
   * interromper e reverter a transação que chamou este método.
   */
  async incrementUsage(invitationId, client = null) {
    const text = `
      UPDATE group_invitations
      SET used_count = used_count + 1,
          status = CASE
            WHEN used_count + 1 >= max_uses THEN 'ACCEPTED'::invitation_status
            ELSE status
          END,
          accepted_at = CASE
            WHEN used_count + 1 >= max_uses THEN NOW() AT TIME ZONE 'UTC'
            ELSE accepted_at
          END,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $1
        AND status = 'PENDING'::invitation_status
        AND used_count < max_uses
        AND expires_at > (NOW() AT TIME ZONE 'UTC')
      RETURNING id, group_id, status, max_uses, used_count, accepted_at;
    `;

    const updated = client
      ? await queryOneClient(client, text, [invitationId])
      : await queryOne(text, [invitationId]);

    if (!updated) {
      throw new ConflictError(
        'Este convite expirou, foi revogado ou atingiu o limite máximo de utilizações.',
        'INVITATION_NOT_USABLE'
      );
    }

    return updated;
  }

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

    const countSql = `
      SELECT COUNT(*)::integer AS total
      FROM group_invitations gi
      WHERE ${whereClause};
    `;

    const countResult = client
      ? await queryOneClient(client, countSql, values)
      : await queryOne(countSql, values);
    const totalCount = countResult ? countResult.total : 0;

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

    const dataResult = client
      ? await queryClient(client, dataSql, values)
      : await query(dataSql, values);

    return {
      rows: dataResult.rows,
      totalCount
    };
  }

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

const invitationsRepository = new InvitationsRepository();

module.exports = invitationsRepository;
