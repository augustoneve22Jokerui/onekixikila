const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para as tabelas `rotation_schedules` e `beneficiary_assignments`.
 * Executa consultas diretas e parametrizadas no Neon PostgreSQL para o controle
 * das rodadas de rotação do bolo da Kixikila, ordenação de posições, registros de permuta
 * consensual entre membros e histórico de contemplações.
 */
class RotationsRepository {
  /**
   * Insere um novo turno de rotação na tabela rotation_schedules.
   *
   * @param {object} params
   * @param {string} params.groupId - UUID do grupo
   * @param {number} params.cycleNumber
   * @param {number} params.positionOrder - Posição ou turno (1 a N)
   * @param {Date|string} params.estimatedPayoutDate - Data estimada de desembolso
   * @param {number|bigint} params.poolTargetAmount - Montante total previsto em Kwanzas (AOA)
   * @param {string} [params.currency='AOA']
   * @param {string} [params.status='PENDING'] - 'PENDING', 'READY_FOR_PAYOUT', 'PAID_OUT', etc.
   * @param {string|null} [params.scheduleId=null] - UUID da rodada de calendário vinculada
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async createRotationSchedule(params, client = null) {
    const {
      groupId,
      cycleNumber,
      positionOrder,
      estimatedPayoutDate,
      poolTargetAmount,
      currency = 'AOA',
      status = 'PENDING',
      scheduleId = null
    } = params;

    const text = `
      INSERT INTO rotation_schedules (
        group_id,
        cycle_number,
        position_order,
        estimated_payout_date,
        pool_target_amount,
        actual_disbursed_amount,
        currency,
        status,
        schedule_id
      )
      VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8)
      RETURNING *;
    `;

    const values = [
      groupId,
      cycleNumber,
      positionOrder,
      estimatedPayoutDate,
      poolTargetAmount,
      currency,
      status,
      scheduleId
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Insere o registro de atribuição de beneficiário para determinado turno em beneficiary_assignments.
   *
   * @param {object} params
   * @param {string} params.rotationId - UUID do turno em rotation_schedules
   * @param {string} params.groupId - UUID do grupo
   * @param {string} params.beneficiaryUserId - UUID do membro contemplado
   * @param {string} params.membershipId - UUID da filiação do membro
   * @param {string} [params.assignmentType='ORIGINAL_ORDER']
   * @param {string|null} [params.assignedBy=null]
   * @param {boolean} [params.approvedByLeader=true]
   * @param {Date|null} [params.leaderApprovedAt=null]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<object>}
   */
  async createBeneficiaryAssignment(params, client = null) {
    const {
      rotationId,
      groupId,
      beneficiaryUserId,
      membershipId,
      assignmentType = 'ORIGINAL_ORDER',
      assignedBy = null,
      approvedByLeader = true,
      leaderApprovedAt = null
    } = params;

    const text = `
      INSERT INTO beneficiary_assignments (
        rotation_id,
        group_id,
        beneficiary_user_id,
        membership_id,
        assignment_type,
        assigned_by,
        approved_by_leader,
        leader_approved_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;

    const values = [
      rotationId,
      groupId,
      beneficiaryUserId,
      membershipId,
      assignmentType,
      assignedBy,
      approvedByLeader,
      leaderApprovedAt
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Lista todos os turnos de rotação do grupo em determinado ciclo, unindo os dados do beneficiário contemplado.
   *
   * @param {string} groupId
   * @param {number} cycleNumber
   * @param {import('pg').PoolClient} [client]
   */
  async listRotationsByGroup(groupId, cycleNumber, client = null) {
    const text = `
      SELECT 
        rs.id AS rotation_id,
        rs.group_id,
        rs.cycle_number,
        rs.position_order,
        rs.estimated_payout_date,
        rs.actual_payout_date,
        rs.pool_target_amount,
        rs.actual_disbursed_amount,
        rs.currency,
        rs.status,
        rs.schedule_id,
        ba.id AS assignment_id,
        ba.beneficiary_user_id,
        ba.assignment_type,
        ba.swapped_with_user_id,
        ba.swap_reason,
        ba.approved_by_leader,
        ba.ledger_payout_id,
        p.full_name AS beneficiary_name,
        p.preferred_name AS beneficiary_preferred_name,
        p.avatar_url AS beneficiary_avatar_url,
        swp.full_name AS swapped_with_name
      FROM rotation_schedules rs
      LEFT JOIN beneficiary_assignments ba ON ba.rotation_id = rs.id
      LEFT JOIN users u ON u.id = ba.beneficiary_user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      LEFT JOIN users swu ON swu.id = ba.swapped_with_user_id
      LEFT JOIN user_profiles swp ON swp.user_id = swu.id
      WHERE rs.group_id = $1 AND rs.cycle_number = $2
      ORDER BY rs.position_order ASC;
    `;

    const result = client
      ? await queryClient(client, text, [groupId, cycleNumber])
      : await query(text, [groupId, cycleNumber]);

    return result.rows;
  }

  /**
   * Localiza o turno ativo de recebimento atribuído a um utilizador num grupo e ciclo específicos.
   *
   * @param {string} groupId
   * @param {number} cycleNumber
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   */
  async findActiveTurnByUser(groupId, cycleNumber, userId, client = null) {
    const text = `
      SELECT 
        rs.id AS rotation_id,
        rs.group_id,
        rs.cycle_number,
        rs.position_order,
        rs.estimated_payout_date,
        rs.pool_target_amount,
        rs.status,
        ba.id AS assignment_id,
        ba.beneficiary_user_id,
        ba.membership_id,
        ba.assignment_type,
        ba.swapped_with_user_id,
        ba.approved_by_leader
      FROM rotation_schedules rs
      INNER JOIN beneficiary_assignments ba ON ba.rotation_id = rs.id
      WHERE rs.group_id = $1
        AND rs.cycle_number = $2
        AND ba.beneficiary_user_id = $3
      LIMIT 1;
    `;

    return client
      ? queryOneClient(client, text, [groupId, cycleNumber, userId])
      : queryOne(text, [groupId, cycleNumber, userId]);
  }

  /**
   * Localiza uma designação de beneficiário pelo seu identificador primário UUID.
   *
   * @param {string} assignmentId
   * @param {import('pg').PoolClient} [client]
   */
  async findAssignmentById(assignmentId, client = null) {
    const text = `
      SELECT 
        ba.id,
        ba.rotation_id,
        ba.group_id,
        ba.beneficiary_user_id,
        ba.membership_id,
        ba.assignment_type,
        ba.assigned_by,
        ba.swapped_with_user_id,
        ba.swap_reason,
        ba.approved_by_leader,
        ba.leader_approved_at,
        ba.ledger_payout_id,
        rs.position_order,
        rs.cycle_number,
        rs.status AS rotation_status
      FROM beneficiary_assignments ba
      INNER JOIN rotation_schedules rs ON rs.id = ba.rotation_id
      WHERE ba.id = $1;
    `;

    return client ? queryOneClient(client, text, [assignmentId]) : queryOne(text, [assignmentId]);
  }

  /**
   * Atualiza a atribuição registando uma solicitação de permuta amigável de turno (SWAP_REQUESTED).
   *
   * @param {object} params
   * @param {string} params.assignmentId
   * @param {string} params.swappedWithUserId
   * @param {string} params.swapReason
   * @param {import('pg').PoolClient} [client]
   */
  async updateAssignmentToSwapRequested({ assignmentId, swappedWithUserId, swapReason }, client = null) {
    const text = `
      UPDATE beneficiary_assignments
      SET assignment_type = 'SWAP_REQUESTED',
          swapped_with_user_id = $1,
          swap_reason = $2,
          approved_by_leader = FALSE,
          leader_approved_at = NULL,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $3
      RETURNING *;
    `;

    const values = [swappedWithUserId, swapReason, assignmentId];
    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Executa a troca atômica dos membros beneficiários e suas filiações entre dois turnos de rotação.
   *
   * @param {object} params
   * @param {string} params.firstRotationId
   * @param {string} params.secondRotationId
   * @param {string} params.firstUserId
   * @param {string} params.secondUserId
   * @param {string} params.firstMembershipId
   * @param {string} params.secondMembershipId
   * @param {string} params.approvedByUserId
   * @param {import('pg').PoolClient} client - Cliente transacional obrigatório
   */
  async swapBeneficiariesBetweenRotations(params, client) {
    const {
      firstRotationId,
      secondRotationId,
      firstUserId,
      secondUserId,
      firstMembershipId,
      secondMembershipId,
      approvedByUserId
    } = params;

    // Atualiza o turno que pertencia ao primeiro utilizador atribuindo-o ao segundo utilizador
    const updateFirstSql = `
      UPDATE beneficiary_assignments
      SET beneficiary_user_id = $1,
          membership_id = $2,
          assignment_type = 'SWAP_APPROVED',
          swapped_with_user_id = $3,
          approved_by_leader = TRUE,
          leader_approved_at = NOW() AT TIME ZONE 'UTC',
          assigned_by = $4,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE rotation_id = $5;
    `;
    await queryClient(client, updateFirstSql, [
      secondUserId,
      secondMembershipId,
      firstUserId,
      approvedByUserId,
      firstRotationId
    ]);

    // Atualiza o turno que pertencia ao segundo utilizador atribuindo-o ao primeiro utilizador
    const updateSecondSql = `
      UPDATE beneficiary_assignments
      SET beneficiary_user_id = $1,
          membership_id = $2,
          assignment_type = 'SWAP_APPROVED',
          swapped_with_user_id = $3,
          approved_by_leader = TRUE,
          leader_approved_at = NOW() AT TIME ZONE 'UTC',
          assigned_by = $4,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE rotation_id = $5;
    `;
    await queryClient(client, updateSecondSql, [
      firstUserId,
      firstMembershipId,
      secondUserId,
      approvedByUserId,
      secondRotationId
    ]);
  }

  /**
   * Reseta a designação de volta ao estado canónico (ORIGINAL_ORDER) cancelando o pedido de permuta.
   *
   * @param {string} assignmentId
   * @param {import('pg').PoolClient} [client]
   */
  async resetAssignmentToOriginal(assignmentId, client = null) {
    const text = `
      UPDATE beneficiary_assignments
      SET assignment_type = 'ORIGINAL_ORDER',
          swapped_with_user_id = NULL,
          swap_reason = NULL,
          approved_by_leader = TRUE,
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $1
      RETURNING *;
    `;

    return client ? queryOneClient(client, text, [assignmentId]) : queryOne(text, [assignmentId]);
  }

  /**
   * Executa a reatribuição emergencial de beneficiário num turno (EMERGENCY_OVERRIDE).
   *
   * @param {object} params
   * @param {string} params.rotationId
   * @param {string} params.newBeneficiaryUserId
   * @param {string} params.newMembershipId
   * @param {string} params.assignedBy
   * @param {string} params.reason
   * @param {import('pg').PoolClient} [client]
   */
  async overrideBeneficiaryAssignment(params, client = null) {
    const {
      rotationId,
      newBeneficiaryUserId,
      newMembershipId,
      assignedBy,
      reason
    } = params;

    const text = `
      UPDATE beneficiary_assignments
      SET beneficiary_user_id = $1,
          membership_id = $2,
          assignment_type = 'EMERGENCY_OVERRIDE',
          assigned_by = $3,
          swap_reason = $4,
          approved_by_leader = TRUE,
          leader_approved_at = NOW() AT TIME ZONE 'UTC',
          updated_at = NOW() AT TIME ZONE 'UTC'
      WHERE rotation_id = $5
      RETURNING *;
    `;

    const values = [newBeneficiaryUserId, newMembershipId, assignedBy, reason, rotationId];
    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Lista os turnos futuros e agendados em que o utilizador é o beneficiário atribuído em todos os grupos.
   *
   * @param {string} userId
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async listUserUpcomingTurns(userId, client = null) {
    const text = `
      SELECT 
        rs.id AS rotation_id,
        rs.group_id,
        rs.cycle_number,
        rs.position_order,
        rs.estimated_payout_date,
        rs.pool_target_amount,
        rs.currency,
        rs.status,
        g.name AS group_name,
        g.slug AS group_slug,
        ba.assignment_type
      FROM beneficiary_assignments ba
      INNER JOIN rotation_schedules rs ON rs.id = ba.rotation_id
      INNER JOIN groups g ON g.id = rs.group_id
      WHERE ba.beneficiary_user_id = $1
        AND rs.status IN ('PENDING', 'READY_FOR_PAYOUT')
      ORDER BY rs.estimated_payout_date ASC;
    `;

    const result = client ? await queryClient(client, text, [userId]) : await query(text, [userId]);
    return result.rows;
  }
}

// Instância singleton do repositório de rotações
const rotationsRepository = new RotationsRepository();

module.exports = rotationsRepository;