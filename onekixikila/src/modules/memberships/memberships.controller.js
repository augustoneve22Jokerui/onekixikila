const membershipsService = require('./memberships.service');

/**
 * Controlador de adaptação HTTP para o módulo de Adesões e Filiações a Grupos de Kixikila.
 * Recebe pedidos de entrada, deliberações de aprovação/rejeição por liderança,
 * aplicação de restrições cautelares, suspensões e cancelamento voluntário de filiação.
 */
class MembershipsController {
  /**
   * Processa a solicitação de adesão de um utilizador a determinado grupo de Kixikila.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async requestJoinGroup(req, res, next) {
    try {
      const groupId = req.params.groupId || req.body.groupId;
      const result = await membershipsService.requestJoinGroup(req.user, groupId, {
        requestId: req.id,
        recordAudit: req.recordAudit
      });

      return res.status(201).json({
        success: true,
        message: result.message,
        data: {
          membershipId: result.membershipId,
          status: result.status,
          slotNumber: result.slotNumber
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Aprovação formal de um pedido de adesão pendente pela liderança do grupo.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async approveMembership(req, res, next) {
    try {
      const membershipId = req.params.membershipId;
      const result = await membershipsService.approveMembership(req.user, membershipId, {
        requestId: req.id,
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          membership: result.membership
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Rejeição de um pedido de adesão pendente pela liderança do grupo.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async rejectMembership(req, res, next) {
    try {
      const membershipId = req.params.membershipId;
      const reason = req.body && req.body.reason ? req.body.reason : 'REJECTED_BY_LEADER';

      const result = await membershipsService.rejectMembership(req.user, membershipId, reason, {
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
   * Aplicação ou remoção de restrições cautelares a um membro (chat, contribuições ou levantamentos).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async updateRestrictions(req, res, next) {
    try {
      const membershipId = req.params.membershipId;
      const updated = await membershipsService.updateRestrictions(req.user, membershipId, req.body, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: 'Restrições operacionais do membro atualizadas.',
        data: {
          membership: updated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Aplica suspensão temporária a um participante do grupo.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async suspendMember(req, res, next) {
    try {
      const membershipId = req.params.membershipId;
      const { reason, suspendedUntil } = req.body;

      if (!reason || typeof reason !== 'string') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_SUSPENSION_REASON',
            message: 'A justificativa formal para a suspensão do membro é obrigatória.'
          }
        });
      }

      const updated = await membershipsService.suspendMember(
        req.user,
        membershipId,
        reason.trim(),
        suspendedUntil ? new Date(suspendedUntil) : null,
        { recordAudit: req.recordAudit }
      );

      return res.status(200).json({
        success: true,
        message: 'Membro suspenso temporariamente no grupo de Kixikila.',
        data: {
          membership: updated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Reativa a filiação ativa de um membro previamente suspenso.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async reactivateMember(req, res, next) {
    try {
      const membershipId = req.params.membershipId;
      const updated = await membershipsService.reactivateMember(req.user, membershipId, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: 'Filiação do membro reativada com sucesso.',
        data: {
          membership: updated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Saída voluntária do grupo com apuração e bloqueio preventivo de compromissos pendentes.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async leaveGroup(req, res, next) {
    try {
      const membershipId = req.params.membershipId;
      const result = await membershipsService.leaveGroup(req.user, membershipId, {
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
   * Consulta a lista de membros de determinado grupo com dados de perfil e papéis internos.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listGroupMembers(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const filters = {
        status: req.query.status,
        role: req.query.role
      };

      const members = await membershipsService.listGroupMembers(req.user, groupId, filters);

      return res.status(200).json({
        success: true,
        data: {
          members
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta os grupos aos quais o próprio utilizador autenticado pertence.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listMyMemberships(req, res, next) {
    try {
      const filters = {
        status: req.query.status
      };

      const memberships = await membershipsService.listUserMemberships(req.user, req.user.id, filters);

      return res.status(200).json({
        success: true,
        data: {
          memberships
        }
      });
    } catch (error) {
      return next(error);
    }
  }
}

// Instância singleton do controlador com vinculação de contexto
const membershipsController = new MembershipsController();
membershipsController.requestJoinGroup = membershipsController.requestJoinGroup.bind(membershipsController);
membershipsController.approveMembership = membershipsController.approveMembership.bind(membershipsController);
membershipsController.rejectMembership = membershipsController.rejectMembership.bind(membershipsController);
membershipsController.updateRestrictions = membershipsController.updateRestrictions.bind(membershipsController);
membershipsController.suspendMember = membershipsController.suspendMember.bind(membershipsController);
membershipsController.reactivateMember = membershipsController.reactivateMember.bind(membershipsController);
membershipsController.leaveGroup = membershipsController.leaveGroup.bind(membershipsController);
membershipsController.listGroupMembers = membershipsController.listGroupMembers.bind(membershipsController);
membershipsController.listMyMemberships = membershipsController.listMyMemberships.bind(membershipsController);

module.exports = membershipsController;