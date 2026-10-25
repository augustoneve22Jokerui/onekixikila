const groupsService = require('./groups.service');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Grupos de Kixikila.
 * Faz a mediação entre requisições HTTP REST, orquestra autorizações contextuais,
 * aciona a camada de serviços (`groupsService`) e padroniza as respostas para web e móvel.
 */
class GroupsController {
  /**
   * Cria um novo grupo de Kixikila com regulamento e localização.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async createGroup(req, res, next) {
    try {
      const group = await groupsService.createGroup(req.user, req.body, {
        requestId: req.id,
        recordAudit: req.recordAudit
      });

      return res.status(201).json({
        success: true,
        message: 'Grupo de Kixikila criado com sucesso.',
        data: {
          group
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta a ficha completa de um grupo pelo seu identificador UUID.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getGroupById(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const group = await groupsService.getGroupById(req.user, groupId);

      return res.status(200).json({
        success: true,
        data: {
          group
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta a ficha pública de um grupo pelo seu slug textual de URL.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getGroupBySlug(req, res, next) {
    try {
      const slug = req.params.slug;
      const group = await groupsService.getGroupBySlug(req.user, slug);

      return res.status(200).json({
        success: true,
        data: {
          group
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Atualiza dados descritivos e cadastrais do grupo.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async updateGroup(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const updated = await groupsService.updateGroup(req.user, groupId, req.body, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: 'Configurações do grupo atualizadas com sucesso.',
        data: {
          group: updated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Atualiza o regulamento interno e regras de rotação da Kixikila (permitido antes do início das rodadas).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async updateRules(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const updatedRules = await groupsService.updateRules(req.user, groupId, req.body, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: 'Regulamento interno atualizado com sucesso.',
        data: {
          rules: updatedRules
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Atualiza a localização territorial aproximada do grupo.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async updateLocation(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const updatedLocation = await groupsService.updateLocation(req.user, groupId, req.body);

      return res.status(200).json({
        success: true,
        message: 'Localização do grupo atualizada com sucesso.',
        data: {
          location: updatedLocation
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Ativa formalmente o grupo de Kixikila iniciando o ciclo operacional de quotas.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async activateGroup(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const activated = await groupsService.activateGroup(req.user, groupId, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: 'Grupo de Kixikila ativado formalmente. As rodadas de contribuição foram iniciadas.',
        data: {
          group: activated
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Pausa temporariamente as operações do grupo de Kixikila.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async pauseGroup(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const reason = req.body && req.body.reason ? req.body.reason : 'Mediação ou pausa preventiva';

      const paused = await groupsService.pauseGroup(req.user, groupId, reason, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: 'Grupo pausado temporariamente.',
        data: {
          group: paused
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Transfere formalmente a liderança do grupo para outro participante ativo.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async changeLeader(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const { newLeaderId } = req.body;

      if (!newLeaderId) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_NEW_LEADER_ID',
            message: 'O identificador do novo líder (newLeaderId) é obrigatório.'
          }
        });
      }

      const result = await groupsService.changeLeader(req.user, groupId, newLeaderId, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: result.message,
        data: {
          newLeaderId: result.newLeaderId
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta paginada e filtrada de grupos no catálogo público.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listGroups(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const filters = {
        frequency: req.query.frequency,
        minAmount: req.query.minAmount,
        maxAmount: req.query.maxAmount,
        province: req.query.province,
        municipality: req.query.municipality,
        status: req.query.status,
        search: paginationParams.search
      };

      const result = await groupsService.listGroups(req.user, filters, paginationParams);

      return res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Descoberta de grupos públicos próximos por geolocalização aproximada.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async findNearbyGroups(req, res, next) {
    try {
      const paginationParams = calculatePaginationParams(req.query);
      const params = {
        latitude: Number(req.query.latitude),
        longitude: Number(req.query.longitude),
        radiusMeters: req.query.radiusMeters ? Number(req.query.radiusMeters) : 10000,
        limit: paginationParams.limit,
        offset: paginationParams.offset,
        page: paginationParams.page
      };

      const result = await groupsService.findNearbyGroups(req.user, params);

      return res.status(200).json({
        success: true,
        data: result.data,
        searchCenter: result.searchCenter,
        pagination: result.pagination
      });
    } catch (error) {
      return next(error);
    }
  }
}

// Instância singleton do controlador com vinculação de contexto
const groupsController = new GroupsController();
groupsController.createGroup = groupsController.createGroup.bind(groupsController);
groupsController.getGroupById = groupsController.getGroupById.bind(groupsController);
groupsController.getGroupBySlug = groupsController.getGroupBySlug.bind(groupsController);
groupsController.updateGroup = groupsController.updateGroup.bind(groupsController);
groupsController.updateRules = groupsController.updateRules.bind(groupsController);
groupsController.updateLocation = groupsController.updateLocation.bind(groupsController);
groupsController.activateGroup = groupsController.activateGroup.bind(groupsController);
groupsController.pauseGroup = groupsController.pauseGroup.bind(groupsController);
groupsController.changeLeader = groupsController.changeLeader.bind(groupsController);
groupsController.listGroups = groupsController.listGroups.bind(groupsController);
groupsController.findNearbyGroups = groupsController.findNearbyGroups.bind(groupsController);

module.exports = groupsController;