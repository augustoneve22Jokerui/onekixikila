const express = require('express');
const { z } = require('zod');
const groupsModuleRoutes = require('../modules/groups/groups.routes');
const membershipsController = require('../modules/memberships/memberships.controller');
const invitationsController = require('../modules/invitations/invitations.controller');
const schedulesController = require('../modules/schedules/schedules.controller');
const rotationsController = require('../modules/rotations/rotations.controller');
const leadershipController = require('../modules/leadership/leadership.controller');
const contributionsController = require('../modules/contributions/contributions.controller');
const { authenticate, authenticateOptional } = require('../middleware/authenticate');
const { validateBody, validateParams, validateQuery } = require('../middleware/validate');
const { createParamIdSchema } = require('../shared/validation/identifiers');
const {
  createInvitationSchema,
  acceptInvitationSchema,
  listInvitationsQuerySchema,
  invitationIdParamSchema,
  inviteCodeParamSchema
} = require('../modules/invitations/invitations.schemas');
const {
  payContributionSchema,
  listContributionsQuerySchema,
  waiveLateFeeSchema,
  contributionIdParamSchema,
  obligationIdParamSchema
} = require('../modules/contributions/contributions.schemas');

const router = express.Router();

const groupIdParamSchema = createParamIdSchema('groupId');
const membershipIdParamSchema = createParamIdSchema('membershipId');
const scheduleIdParamSchema = createParamIdSchema('scheduleId');
const rotationIdParamSchema = createParamIdSchema('rotationId');
const assignmentIdParamSchema = createParamIdSchema('assignmentId');

// -----------------------------------------------------------------------------
// 1. Delegação das Rotas Base do Módulo de Grupos (CRUD, Localização, Slugs)
// -----------------------------------------------------------------------------
router.use('/', groupsModuleRoutes);

// -----------------------------------------------------------------------------
// 2. Filiação e Gestão de Membros (Memberships)
// -----------------------------------------------------------------------------

/**
 * @route   POST /:groupId/join
 * @desc    Solicitação de adesão de um membro a um grupo de Kixikila
 * @access  Privado
 */
router.post(
  '/:groupId/join',
  authenticate,
  validateParams(groupIdParamSchema),
  membershipsController.requestJoinGroup
);

/**
 * @route   GET /:groupId/members
 * @desc    Lista os membros participantes do grupo com vagas e papéis
 * @access  Privado (Membros ativos ou Auditores)
 */
router.get(
  '/:groupId/members',
  authenticate,
  validateParams(groupIdParamSchema),
  membershipsController.listGroupMembers
);

/**
 * @route   POST /memberships/:membershipId/approve
 * @desc    Aprovação formal de um pedido de adesão pendente (Liderança do grupo)
 * @access  Privado
 */
router.post(
  '/memberships/:membershipId/approve',
  authenticate,
  validateParams(membershipIdParamSchema),
  membershipsController.approveMembership
);

/**
 * @route   POST /memberships/:membershipId/reject
 * @desc    Rejeição de um pedido de adesão pendente (Liderança do grupo)
 * @access  Privado
 */
router.post(
  '/memberships/:membershipId/reject',
  authenticate,
  validateParams(membershipIdParamSchema),
  membershipsController.rejectMembership
);

/**
 * @route   POST /memberships/:membershipId/suspend
 * @desc    Suspensão temporária da participação de um membro
 * @access  Privado (Liderança do grupo ou Administradores)
 */
router.post(
  '/memberships/:membershipId/suspend',
  authenticate,
  validateParams(membershipIdParamSchema),
  membershipsController.suspendMember
);

/**
 * @route   POST /memberships/:membershipId/reactivate
 * @desc    Reativação de um membro suspenso
 * @access  Privado (Liderança do grupo ou Administradores)
 */
router.post(
  '/memberships/:membershipId/reactivate',
  authenticate,
  validateParams(membershipIdParamSchema),
  membershipsController.reactivateMember
);

/**
 * @route   POST /memberships/:membershipId/leave
 * @desc    Saída voluntária do grupo com verificação de obrigações quitadas
 * @access  Privado
 */
router.post(
  '/memberships/:membershipId/leave',
  authenticate,
  validateParams(membershipIdParamSchema),
  membershipsController.leaveGroup
);

// -----------------------------------------------------------------------------
// 3. Convites e Códigos QR de Grupo (Invitations)
// -----------------------------------------------------------------------------

/**
 * @route   POST /:groupId/invitations
 * @desc    Emissão de convite seguro para ingresso no grupo
 * @access  Privado (Membros autorizados ou Líder)
 */
router.post(
  '/:groupId/invitations',
  authenticate,
  validateParams(groupIdParamSchema),
  validateBody(createInvitationSchema),
  invitationsController.createInvitation
);

/**
 * @route   GET /:groupId/invitations
 * @desc    Consulta dos convites emitidos para o grupo
 * @access  Privado (Líder titular ou Administradores)
 */
router.get(
  '/:groupId/invitations',
  authenticate,
  validateParams(groupIdParamSchema),
  validateQuery(listInvitationsQuerySchema),
  invitationsController.listGroupInvitations
);

/**
 * @route   GET /invitations/:inviteCode
 * @desc    Pré-visualização pública de informações do grupo por código de convite
 * @access  Público
 */
router.get(
  '/invitations/:inviteCode',
  authenticateOptional,
  validateParams(inviteCodeParamSchema),
  invitationsController.getInvitationByCode
);

/**
 * @route   POST /invitations/accept
 * @desc    Aceitação e consumo do convite de adesão
 * @access  Privado
 */
router.post(
  '/invitations/accept',
  authenticate,
  validateBody(acceptInvitationSchema),
  invitationsController.acceptInvitation
);

/**
 * @route   DELETE /invitations/:invitationId
 * @desc    Revogação formal de convite pendente
 * @access  Privado (Emissor ou Líder)
 */
router.delete(
  '/invitations/:invitationId',
  authenticate,
  validateParams(invitationIdParamSchema),
  invitationsController.revokeInvitation
);

// -----------------------------------------------------------------------------
// 4. Calendário e Rodadas de Quotas (Schedules)
// -----------------------------------------------------------------------------

/**
 * @route   POST /:groupId/schedules/generate
 * @desc    Gera o cronograma de rodadas de contribuição do ciclo
 * @access  Privado (Líder titular ou Administradores)
 */
router.post(
  '/:groupId/schedules/generate',
  authenticate,
  validateParams(groupIdParamSchema),
  schedulesController.generateSchedule
);

/**
 * @route   GET /:groupId/schedules
 * @desc    Consulta as rodadas e datas de vencimento do grupo
 * @access  Privado (Membros do grupo)
 */
router.get(
  '/:groupId/schedules',
  authenticate,
  validateParams(groupIdParamSchema),
  schedulesController.getGroupSchedule
);

/**
 * @route   POST /schedules/:scheduleId/activate
 * @desc    Ativação de rodada e emissão de obrigações individuais
 * @access  Privado (Líder do grupo)
 */
router.post(
  '/schedules/:scheduleId/activate',
  authenticate,
  validateParams(scheduleIdParamSchema),
  schedulesController.activateRound
);

/**
 * @route   POST /schedules/:scheduleId/complete
 * @desc    Conclusão da rodada após quitação de quotas
 * @access  Privado (Líder do grupo)
 */
router.post(
  '/schedules/:scheduleId/complete',
  authenticate,
  validateParams(scheduleIdParamSchema),
  schedulesController.completeRound
);

/**
 * @route   GET /schedules/:scheduleId
 * @desc    Detalhes da rodada com lista de obrigações de cada participante
 * @access  Privado (Membros do grupo)
 */
router.get(
  '/schedules/:scheduleId',
  authenticate,
  validateParams(scheduleIdParamSchema),
  schedulesController.getRoundDetails
);

// -----------------------------------------------------------------------------
// 5. Rotações e Ordem dos Beneficiários (Rotations)
// -----------------------------------------------------------------------------

/**
 * @route   POST /:groupId/rotations/generate
 * @desc    Gera o plano formal de turnos de recebimento do bolo da Kixikila
 * @access  Privado (Líder do grupo)
 */
router.post(
  '/:groupId/rotations/generate',
  authenticate,
  validateParams(groupIdParamSchema),
  rotationsController.generateRotationPlan
);

/**
 * @route   GET /:groupId/rotations
 * @desc    Consulta as posições e datas estimadas de contemplação do ciclo
 * @access  Privado (Membros do grupo)
 */
router.get(
  '/:groupId/rotations',
  authenticate,
  validateParams(groupIdParamSchema),
  rotationsController.getGroupRotations
);

/**
 * @route   POST /:groupId/rotations/swap
 * @desc    Solicitação de troca amigável de turno entre dois membros
 * @access  Privado (Membro titular do turno)
 */
router.post(
  '/:groupId/rotations/swap',
  authenticate,
  validateParams(groupIdParamSchema),
  rotationsController.requestTurnSwap
);

/**
 * @route   POST /:groupId/rotations/assignments/:assignmentId/approve-swap
 * @desc    Homologação de permuta de turno pela liderança
 * @access  Privado (Líder do grupo)
 */
router.post(
  '/:groupId/rotations/assignments/:assignmentId/approve-swap',
  authenticate,
  validateParams(createParamIdSchema('groupId')),
  rotationsController.approveTurnSwap
);

/**
 * @route   POST /:groupId/rotations/assignments/:assignmentId/reject-swap
 * @desc    Rejeição de permuta de turno
 * @access  Privado (Líder do grupo)
 */
router.post(
  '/:groupId/rotations/assignments/:assignmentId/reject-swap',
  authenticate,
  validateParams(createParamIdSchema('groupId')),
  rotationsController.rejectTurnSwap
);

/**
 * @route   POST /:groupId/rotations/:rotationId/override
 * @desc    Reatribuição emergencial de beneficiário da vez
 * @access  Privado (Líder do grupo ou Administradores)
 */
router.post(
  '/:groupId/rotations/:rotationId/override',
  authenticate,
  validateParams(createParamIdSchema('groupId')),
  rotationsController.emergencyOverrideTurn
);

// -----------------------------------------------------------------------------
// 6. Delegação de Liderança (Leadership)
// -----------------------------------------------------------------------------

/**
 * @route   POST /:groupId/leadership/delegate
 * @desc    Delegação de mandato de vice-liderança ou interino
 * @access  Privado (Líder titular)
 */
router.post(
  '/:groupId/leadership/delegate',
  authenticate,
  validateParams(groupIdParamSchema),
  leadershipController.delegateLeadership
);

/**
 * @route   DELETE /:groupId/leadership/:assignmentId
 * @desc    Revogação de delegação de liderança
 * @access  Privado (Líder titular)
 */
router.delete(
  '/:groupId/leadership/:assignmentId',
  authenticate,
  validateParams(createParamIdSchema('groupId')),
  leadershipController.revokeDelegation
);

/**
 * @route   GET /:groupId/leadership
 * @desc    Consulta a composição de liderança ativa do grupo
 * @access  Privado
 */
router.get(
  '/:groupId/leadership',
  authenticate,
  validateParams(groupIdParamSchema),
  leadershipController.getActiveLeadership
);

/**
 * @route   GET /:groupId/leadership/history
 * @desc    Consulta o histórico institucional de governança do grupo
 * @access  Privado (Membros do grupo)
 */
router.get(
  '/:groupId/leadership/history',
  authenticate,
  validateParams(groupIdParamSchema),
  leadershipController.getLeadershipHistory
);

// -----------------------------------------------------------------------------
// 7. Pagamento de Quotas e Contribuições (Contributions)
// -----------------------------------------------------------------------------

/**
 * @route   POST /contributions/pay
 * @desc    Liquidação de quota de Kixikila (carteira interna ou gateway externo)
 * @access  Privado
 */
router.post(
  '/contributions/pay',
  authenticate,
  validateBody(payContributionSchema),
  contributionsController.payContribution
);

/**
 * @route   GET /:groupId/contributions
 * @desc    Consulta o histórico de quotas arrecadadas no grupo
 * @access  Privado (Membros do grupo)
 */
router.get(
  '/:groupId/contributions',
  authenticate,
  validateParams(groupIdParamSchema),
  validateQuery(listContributionsQuerySchema),
  contributionsController.listGroupContributions
);

/**
 * @route   GET /contributions/:contributionId
 * @desc    Detalhes de uma contribuição individual com comprovativo
 * @access  Privado
 */
router.get(
  '/contributions/:contributionId',
  authenticate,
  validateParams(contributionIdParamSchema),
  contributionsController.getContributionById
);

/**
 * @route   POST /obligations/:obligationId/waive-late-fee
 * @desc    Dispensa/perdão de multa de mora (Decisão da liderança)
 * @access  Privado (Líder do grupo)
 */
router.post(
  '/obligations/:obligationId/waive-late-fee',
  authenticate,
  validateParams(obligationIdParamSchema),
  validateBody(waiveLateFeeSchema),
  contributionsController.waiveLateFee
);

module.exports = router;