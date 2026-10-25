const QRCode = require('qrcode');
const invitationsRepository = require('./invitations.repository');
const invitationsPolicy = require('./invitations.policy');
const groupsRepository = require('../groups/groups.repository');
const membershipsRepository = require('../memberships/memberships.repository');
const tokenSecurity = require('../../shared/security/tokens');
const appConfig = require('../../config/app');
const { withTransaction } = require('../../database/transaction');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const eventBus = require('../../shared/events/event-bus');
const { EVENT_TYPES } = require('../../shared/events/event-types');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ConflictError = require('../../shared/errors/conflict-error');

/**
 * Serviço de regras de negócio para Emissão, Resgate e Auditoria de Convites
 * e Códigos QR de Grupos de Kixikila na plataforma OneKixikila.
 */
class InvitationsService {
  /**
   * Emite um convite seguro com código imprevisível de alta entropia.
   * Gera hiperligação de acesso e Código QR correspondente caso o canal selecionado seja 'QR_CODE'.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} groupId - UUID do grupo
   * @param {object} invitationData - Parâmetros validados por createInvitationSchema
   * @param {object} [context={}]
   * @returns {Promise<object>} Detalhes do convite emitido com link e QR Code
   */
  async createInvitation(actingUser, groupId, invitationData, context = {}) {
    const {
      channel = 'DIRECT_LINK',
      invitedPhone = null,
      invitedEmail = null,
      invitedUserId = null,
      maxUses = 1,
      expiresInDays = 7
    } = invitationData;

    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const actingMembership = await membershipsRepository.findByGroupAndUser(groupId, actingUser.id);
    const permissionCheck = invitationsPolicy.canCreateInvitation(actingUser, group, actingMembership);
    if (!permissionCheck.allowed) {
      throw new AuthorizationError(permissionCheck.reason);
    }

    // Geração de código criptograficamente seguro e prazo de vigência
    const { inviteCode, expiresAt } = tokenSecurity.generateInviteCode(16);

    const invitation = await invitationsRepository.createInvitation({
      groupId,
      invitedBy: actingUser.id,
      inviteCode,
      channel,
      invitedPhone,
      invitedEmail,
      invitedUserId,
      maxUses,
      expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
    });

    const inviteLink = `${appConfig.baseUrl}/groups/join?code=${inviteCode}`;
    let qrCodeDataUrl = null;

    // Se o canal solicitado for QR_CODE, gera a imagem matricial em formato Data URL
    if (channel === 'QR_CODE') {
      qrCodeDataUrl = await QRCode.toDataURL(inviteLink, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 300
      });
    }

    eventBus.publish(EVENT_TYPES.GROUP_INVITATION_SENT, {
      invitationId: invitation.id,
      groupId,
      invitedBy: actingUser.id,
      channel,
      invitedPhone,
      invitedEmail
    }, { requestId: context.requestId });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'CREATE',
        resourceType: 'GROUP_INVITATION',
        resourceId: invitation.id,
        metadata: {
          groupId,
          channel,
          maxUses,
          expiresAt: invitation.expires_at
        }
      });
    }

    return {
      invitationId: invitation.id,
      inviteCode: invitation.invite_code,
      channel: invitation.channel,
      inviteLink,
      qrCodeDataUrl,
      maxUses: invitation.max_uses,
      expiresAt: invitation.expires_at,
      message: 'Convite emitido com sucesso.'
    };
  }

  /**
   * Consulta a pré-visualização segura de um convite a partir do código textual.
   * Apresenta dados descritivos do grupo para confirmação prévia pelo utilizador convidado.
   *
   * @param {string} inviteCode
   * @returns {Promise<object>} Ficha de apresentação do convite e grupo
   */
  async getInvitationByCode(inviteCode) {
    const invitation = await invitationsRepository.findByCode(inviteCode);
    if (!invitation) {
      throw NotFoundError.resource('Convite', inviteCode);
    }

    const usableCheck = invitationsPolicy.isInvitationUsable(invitation);
    if (!usableCheck.usable) {
      throw new ConflictError(usableCheck.reason, 'INVITATION_NOT_USABLE');
    }

    return {
      inviteCode: invitation.invite_code,
      channel: invitation.channel,
      expiresAt: invitation.expires_at,
      inviterName: invitation.inviter_name,
      group: {
        name: invitation.group_name,
        slug: invitation.group_slug,
        frequency: invitation.frequency,
        contributionAmount: Number(invitation.contribution_amount),
        currency: invitation.currency,
        minMembers: invitation.min_members,
        maxMembers: invitation.max_members,
        status: invitation.group_status
      }
    };
  }

  /**
   * Executa a aceitação e consumo do convite por um utilizador autenticado.
   * Valida quotas de leitura, integridade do grupo e inscreve o membro com status ACTIVE no próximo slot vago.
   *
   * @param {object} user - Utilizador autenticado (req.user)
   * @param {string} inviteCode - Código do convite
   * @param {object} [context={}]
   * @returns {Promise<object>} Confirmação de filiação ao grupo
   */
  async acceptInvitation(user, inviteCode, context = {}) {
    const invitation = await invitationsRepository.findByCode(inviteCode);
    if (!invitation) {
      throw NotFoundError.resource('Convite', inviteCode);
    }

    const group = await groupsRepository.findById(invitation.group_id);
    if (!group) {
      throw NotFoundError.group(invitation.group_id);
    }

    const existingMembership = await membershipsRepository.findByGroupAndUser(group.id, user.id);
    const isAlreadyMember = Boolean(existingMembership && existingMembership.status !== 'LEFT' && existingMembership.status !== 'EXPELLED');
    const activeCount = Number(group.active_members_count) || 0;
    const userTier = user.identity_tier || 'TIER_1_UNVERIFIED';

    const acceptCheck = invitationsPolicy.canAcceptInvitation(user, invitation, group, activeCount, isAlreadyMember, userTier);
    if (!acceptCheck.allowed) {
      throw new ConflictError(acceptCheck.reason, 'INVITATION_ACCEPTANCE_BLOCKED');
    }

    // Execução atómica da aceitação e filiação com incremento de utilização
    const result = await withTransaction(async (client) => {
      // 1. Incrementa o contador de utilizações do convite
      await invitationsRepository.incrementUsage(invitation.id, client);

      // 2. Aloca a próxima vaga/turno livre (Slot) na rotação
      const nextSlot = await membershipsRepository.getNextAvailableSlot(group.id, client);

      // 3. Cria a filiação direta como membro ativo homologado pelo convite
      const membership = await membershipsRepository.createMembership(
        {
          groupId: group.id,
          userId: user.id,
          role: 'MEMBER',
          status: 'ACTIVE',
          slotNumber: nextSlot,
          approvedBy: invitation.invited_by
        },
        client
      );

      return {
        membership,
        slotNumber: nextSlot
      };
    });

    eventBus.publish(EVENT_TYPES.GROUP_INVITATION_ACCEPTED, {
      invitationId: invitation.id,
      groupId: group.id,
      userId: user.id,
      membershipId: result.membership.id
    }, { requestId: context.requestId });

    eventBus.publish(EVENT_TYPES.GROUP_MEMBERSHIP_APPROVED, {
      groupId: group.id,
      userId: user.id,
      membershipId: result.membership.id,
      slotNumber: result.slotNumber,
      approvedBy: invitation.invited_by
    }, { requestId: context.requestId });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'GROUP_INVITATION',
        resourceId: invitation.id,
        metadata: {
          acceptedByUserId: user.id,
          membershipId: result.membership.id,
          slotNumber: result.slotNumber
        }
      });
    }

    return {
      message: 'Convite aceite com sucesso! A sua participação no grupo de Kixikila foi confirmada.',
      groupId: group.id,
      groupName: group.name,
      groupSlug: group.slug,
      slotNumber: result.slotNumber
    };
  }

  /**
   * Revoga formalmente um convite pendente.
   *
   * @param {object} actingUser
   * @param {string} invitationId
   * @param {object} [context={}]
   * @returns {Promise<{ message: string }>}
   */
  async revokeInvitation(actingUser, invitationId, context = {}) {
    const invitation = await invitationsRepository.findById(invitationId);
    if (!invitation) {
      throw NotFoundError.resource('Convite', invitationId);
    }

    const group = await groupsRepository.findById(invitation.group_id);
    const revokeCheck = invitationsPolicy.canRevokeInvitation(actingUser, invitation, group);
    if (!revokeCheck.allowed) {
      throw new AuthorizationError(revokeCheck.reason);
    }

    await invitationsRepository.revokeInvitation(invitationId);

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'DELETE',
        resourceType: 'GROUP_INVITATION',
        resourceId: invitationId,
        metadata: {
          groupId: invitation.group_id,
          revokedBy: actingUser.id
        }
      });
    }

    return {
      message: 'Convite revogado com sucesso.'
    };
  }

  /**
   * Lista os convites emitidos para determinado grupo para auditoria da liderança.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @param {object} filters
   * @param {object} paginationParams
   * @returns {Promise<object>}
   */
  async listGroupInvitations(actingUser, groupId, filters, paginationParams) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const isLeader = actingUser.id === group.leader_id || actingUser.role === 'ADMIN';
    if (!isLeader) {
      throw AuthorizationError.forbiddenResource('Apenas a liderança do grupo pode auditar a lista de convites.');
    }

    const { limit, offset, page } = paginationParams;
    const { rows, totalCount } = await invitationsRepository.listGroupInvitations(groupId, filters, { limit, offset });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }
}

// Instância singleton do serviço de convites
const invitationsService = new InvitationsService();

module.exports = invitationsService;