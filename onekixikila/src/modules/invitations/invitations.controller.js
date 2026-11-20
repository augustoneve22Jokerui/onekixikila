// =============================================================================
// modules/invitations/invitations.controller.js
// =============================================================================

const invitationsService = require('./invitations.service');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Convites e Códigos QR de Grupos de Kixikila.
 */
class InvitationsController {
  async createInvitation(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const result = await invitationsService.createInvitation(req.user, groupId, req.body, {
        requestId: req.id,
        recordAudit: req.recordAudit
      });

      return res.status(201).json({
        success: true,
        message: result.message,
        data: {
          invitationId: result.invitationId,
          inviteCode: result.inviteCode,
          channel: result.channel,
          inviteLink: result.inviteLink,
          qrCodeDataUrl: result.qrCodeDataUrl,
          maxUses: result.maxUses,
          expiresAt: result.expiresAt
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  async getInvitationByCode(req, res, next) {
    try {
      const inviteCode = req.params.inviteCode || req.query.code || req.query.inviteCode;

      if (!inviteCode) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_INVITE_CODE',
            message: 'O código do convite é obrigatório para consulta.'
          }
        });
      }

      const preview = await invitationsService.getInvitationByCode(String(inviteCode).trim());

      return res.status(200).json({
        success: true,
        data: preview
      });
    } catch (error) {
      return next(error);
    }
  }

  async acceptInvitation(req, res, next) {
    try {
      const inviteCode =
        req.body.inviteCode ||
        req.params.inviteCode ||
        req.query.code ||
        req.query.inviteCode;

      if (!inviteCode) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_INVITE_CODE',
            message: 'O código do convite é obrigatório para aceitação.'
          }
        });
      }

      const result = await invitationsService.acceptInvitation(req.user, String(inviteCode).trim(), {
        requestId: req.id,
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          groupId: result.groupId,
          groupName: result.groupName,
          groupSlug: result.groupSlug,
          slotNumber: result.slotNumber
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  async revokeInvitation(req, res, next) {
    try {
      const invitationId = req.params.invitationId;
      const result = await invitationsService.revokeInvitation(req.user, invitationId, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message
      });
    } catch (error) {
      return next(error);
    }
  }

  async listGroupInvitations(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        status: req.query.status,
        channel: req.query.channel
      };

      const result = await invitationsService.listGroupInvitations(
        req.user,
        groupId,
        filters,
        paginationParams
      );

      return res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error) {
      return next(error);
    }
  }
}

const invitationsController = new InvitationsController();
invitationsController.createInvitation = invitationsController.createInvitation.bind(invitationsController);
invitationsController.getInvitationByCode = invitationsController.getInvitationByCode.bind(invitationsController);
invitationsController.acceptInvitation = invitationsController.acceptInvitation.bind(invitationsController);
invitationsController.revokeInvitation = invitationsController.revokeInvitation.bind(invitationsController);
invitationsController.listGroupInvitations = invitationsController.listGroupInvitations.bind(invitationsController);

module.exports = invitationsController;