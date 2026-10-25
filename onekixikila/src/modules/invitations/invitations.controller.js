const invitationsService = require('./invitations.service');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Convites e Códigos QR de Grupos de Kixikila.
 * Faz a interface com a camada de serviços (`invitationsService`) para emissão de convites,
 * geração de QR Codes dinâmicos, pré-visualização segura de grupos, resgate/aceitação e revogação.
 */
class InvitationsController {
  /**
   * Emite um novo convite seguro (link direto, QR Code, SMS ou e-mail) para um grupo.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
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

  /**
   * Consulta a pré-visualização das informações públicas de um grupo a partir do código do convite.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getInvitationByCode(req, res, next) {
    try {
      const inviteCode = req.params.inviteCode || req.query.code;

      if (!inviteCode) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_INVITE_CODE',
            message: 'O código do convite é obrigatório para consulta.'
          }
        });
      }

      const preview = await invitationsService.getInvitationByCode(inviteCode);

      return res.status(200).json({
        success: true,
        data: preview
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Aceita e consome um convite para ingresso imediato no grupo de Kixikila.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async acceptInvitation(req, res, next) {
    try {
      const inviteCode = req.body.inviteCode || req.params.inviteCode;

      if (!inviteCode) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_INVITE_CODE',
            message: 'O código do convite é obrigatório para aceitação.'
          }
        });
      }

      const result = await invitationsService.acceptInvitation(req.user, inviteCode, {
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

  /**
   * Revoga formalmente um convite pendente.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
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

  /**
   * Lista os convites emitidos para determinado grupo para auditoria da liderança.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
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

// Instância singleton do controlador com vinculação de contexto
const invitationsController = new InvitationsController();
invitationsController.createInvitation = invitationsController.createInvitation.bind(invitationsController);
invitationsController.getInvitationByCode = invitationsController.getInvitationByCode.bind(invitationsController);
invitationsController.acceptInvitation = invitationsController.acceptInvitation.bind(invitationsController);
invitationsController.revokeInvitation = invitationsController.revokeInvitation.bind(invitationsController);
invitationsController.listGroupInvitations = invitationsController.listGroupInvitations.bind(invitationsController);

module.exports = invitationsController;