const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de acesso a dados SQL para a tabela `leadership_assignments`.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para registo de mandatos,
 * delegação de poderes temporários (Vice-Líder, Líder Interino), revogação e histórico de governança.
 */
class LeadershipRepository {
  /**
   * Insere um novo registo de designação formal de liderança.
   *
   * @param {object} params
   * @param {string} params.groupId - UUID do grupo de Kixikila
   * @param {string} params.userId - UUID do utilizador designado
   * @param {string} [params.leadershipRole='PRIMARY_LEADER'] - 'PRIMARY_LEADER', 'VICE_LEADER', 'ACTING_LEADER'
   * @param {string} [params.status='ACTIVE'] - 'ACTIVE', 'DELEGATED'
   * @param {string|null} [params.assignedBy] - UUID de quem designou
   * @param {Date|null} [params.delegatedUntil] - Data limite para liderança temporária/interina
   * @param {object} [params.powers] - Objeto de poderes delegados
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async createAssignment(params, client = null) {
    const {
      groupId,
      userId,
      leadershipRole = 'PRIMARY_LEADER',
      status = 'ACTIVE',
      assignedBy = null,
      delegatedUntil = null,
      powers = { can_approve_members: true, can_manage_schedule: true, can_moderate_chat: true }
    } = params;

    const text = `
      INSERT INTO leadership_assignments (
        group_id,
        user_id,
        leadership_role,
        status,
        assigned_by,
        assigned_at,
        delegated_until,
        powers
      )
      VALUES ($1, $2, $3, $4, $5, NOW() AT TIME ZONE 'UTC', $6, $7::jsonb)
      RETURNING *;
    `;

    const values = [
      groupId,
      userId,
      leadershipRole,
      status,
      assignedBy,
      delegatedUntil,
      JSON.stringify(powers)
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza uma designação de liderança pelo seu identificador primário UUID.
   *
   * @param {string} assignmentId
   * @param {import('pg').PoolClient} [client]
   */
  async findById(assignmentId, client = null) {
    const text = `
      SELECT 
        la.id,
        la.group_id,
        la.user_id,
        la.leadership_role,
        la.status,
        la.assigned_by,
        la.assigned_at,
        la.revoked_by,
        la.revoked_at,
        la.revocation_reason,
        la.delegated_until,
        la.powers,
        la.created_at,
        la.updated_at,
        u.email,
        u.phone_number,
        p.full_name,
        p.preferred_name,
        g.name AS group_name
      FROM leadership_assignments la
      INNER JOIN groups g ON g.id = la.group_id
      INNER JOIN users u ON u.id = la.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE la.id = $1;
    `;

    return client ? queryOneClient(client, text, [assignmentId]) : queryOne(text, [assignmentId]);
  }

  /**
   * Lista todas as designações de liderança ativas de determinado grupo.
   *
   * @param {string} groupId
   * @param {import('pg').PoolClient} [client]
   */
  async findActiveLeadership(groupId, client = null) {
    const text = `
      SELECT 
        la.id,
        la.group_id,
        la.user_id,
        la.leadership_role,
        la.status,
        la.assigned_at,
        la.delegated_until,
        la.powers,
        p.full_name,
        p.preferred_name,
        p.avatar_url
      FROM leadership_assignments la
      INNER JOIN users u ON u.id = la.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE la.group_id = $1
        AND la.status = 'ACTIVE'
        AND (la.delegated_until IS NULL OR la.delegated_until > (NOW() AT TIME ZONE 'UTC'))
      ORDER BY 
        CASE la.leadership_role
          WHEN 'PRIMARY_LEADER' THEN 1
          WHEN 'VICE_LEADER' THEN 2
          WHEN 'ACTING_LEADER' THEN 3
          ELSE 4
        END ASC;
    `;

    const result = client ? await queryClient(client, text, [groupId]) : await query(text, [groupId]);
    return result.rows;
  }

  /**
   * Obtém a designação ativa do líder titular (PRIMARY_LEADER) do grupo.
   *
   * @param {string} groupId
   * @param {import('pg').PoolClient} [client]
   */
  async findPrimaryLeader(groupId, client = null) {
    const text = `
      SELECT 
        la.id,
        la.group_id,
        la.user_id,
        la.leadership_role,
        la.status,
        la.assigned_at,
        la.powers,
        p.full_name
      FROM leadership_assignments la
      INNER JOIN users u ON u.id = la.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE la.group_id = $1
        AND la.leadership_role = 'PRIMARY_LEADER'
        AND la.status = 'ACTIVE'
      LIMIT 1;
    `;

    return client ? queryOneClient(client, text, [groupId]) : queryOne(text, [groupId]);
  }

  /**
   * Consulta a designação de liderança ativa de um utilizador específico em determinado grupo.
   *
   * @param {string} groupId
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   */
  async findActiveAssignmentByUserAndGroup(groupId, userId, client = null) {
    const text = `
      SELECT 
        la.id,
        la.group_id,
        la.user_id,
        la.leadership_role,
        la.status,
        la.assigned_at,
        la.delegated_until,
        la.powers
      FROM leadership_assignments la
      WHERE la.group_id = $1
        AND la.user_id = $2
        AND la.status = 'ACTIVE'
        AND (la.delegated_until IS NULL OR la.delegated_until > (NOW() AT TIME ZONE 'UTC'))
      LIMIT 1;
    `;

    return client ? queryOneClient(client, text, [groupId, userId]) : queryOne(text, [groupId, userId]);
  }

  /**
   * Revoga formalmente uma designação de liderança informando motivo e autor da revogação.
   *
   * @param {string} assignmentId
   * @param {object} params
   * @param {string} params.revokedBy
   * @param {string} params.reason
   * @param {import('pg').PoolClient} [client]
   */
  async revokeAssignment(assignmentId, { revokedBy, reason }, client = null) {
    const text = `
      UPDATE leadership_assignments
      SET status = 'REVOKED',
          revoked_by = $1,
          revocation_reason = $2,
          revoked_at = NOW() AT TIME ZONE 'UTC',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $3
      RETURNING *;
    `;

    const values = [revokedBy, reason, assignmentId];
    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Revoga todas as designações de liderança ativas de um papel específico no grupo.
   *
   * @param {string} groupId
   * @param {string} role - 'PRIMARY_LEADER', 'VICE_LEADER', etc.
   * @param {object} params
   * @param {string} params.revokedBy
   * @param {string} params.reason
   * @param {import('pg').PoolClient} [client]
   */
  async revokeActiveAssignmentsByRole(groupId, role, { revokedBy, reason }, client = null) {
    const text = `
      UPDATE leadership_assignments
      SET status = 'REVOKED',
          revoked_by = $1,
          revocation_reason = $2,
          revoked_at = NOW() AT TIME ZONE 'UTC',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE group_id = $3
        AND leadership_role = $4
        AND status = 'ACTIVE';
    `;

    const values = [revokedBy, reason, groupId, role];
    const result = client ? await queryClient(client, text, values) : await query(text, values);
    return result.rowCount;
  }

  /**
   * Atualiza a matriz de permissões/poderes delegados de uma liderança ativa.
   *
   * @param {string} assignmentId
   * @param {object} powers
   * @param {import('pg').PoolClient} [client]
   */
  async updatePowers(assignmentId, powers, client = null) {
    const text = `
      UPDATE leadership_assignments
      SET powers = $1::jsonb,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $2
      RETURNING id, powers, updated_at;
    `;

    const values = [JSON.stringify(powers), assignmentId];
    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Consulta o histórico completo de mandatos e delegações de liderança do grupo para auditoria.
   *
   * @param {string} groupId
   * @param {import('pg').PoolClient} [client]
   */
  async listLeadershipHistory(groupId, client = null) {
    const text = `
      SELECT 
        la.id,
        la.user_id,
        la.leadership_role,
        la.status,
        la.assigned_at,
        la.revoked_at,
        la.revocation_reason,
        la.delegated_until,
        p.full_name AS leader_name,
        ap.full_name AS assigned_by_name,
        rp.full_name AS revoked_by_name
      FROM leadership_assignments la
      INNER JOIN users u ON u.id = la.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      LEFT JOIN user_profiles ap ON ap.user_id = la.assigned_by
      LEFT JOIN user_profiles rp ON rp.user_id = la.revoked_by
      WHERE la.group_id = $1
      ORDER BY la.created_at DESC;
    `;

    const result = client ? await queryClient(client, text, [groupId]) : await query(text, [groupId]);
    return result.rows;
  }
}

// Instância singleton do repositório de liderança
const leadershipRepository = new LeadershipRepository();

module.exports = leadershipRepository;