const locationsService = require('./locations.service');
const { calculatePaginationParams } = require('../../shared/validation/pagination');

/**
 * Controlador de adaptação HTTP para o módulo de Localizações e Descoberta Territorial em Angola.
 * Trata requisições de atualização de georreferenciação de grupos de Kixikila, consultas com salvaguarda
 * de privacidade, busca geoespacial por raio de proximidade e navegação por províncias e municípios angolanos.
 */
class LocationsController {
  /**
   * Atualiza a localização territorial e as coordenadas aproximadas de um grupo de Kixikila.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async updateGroupLocation(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const location = await locationsService.updateGroupLocation(req.user, groupId, req.body, {
        recordAudit: req.recordAudit
      });

      return res.status(200).json({
        success: true,
        message: 'Localização do grupo atualizada com sucesso.',
        data: {
          location
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Consulta a localização de determinado grupo com mascaramento confidencial para não-líderes.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async getGroupLocation(req, res, next) {
    try {
      const groupId = req.params.groupId;
      const location = await locationsService.getGroupLocation(req.user, groupId);

      return res.status(200).json({
        success: true,
        data: {
          location
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Pesquisa grupos de Kixikila abertos e próximos por raio de distância esférica.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async searchNearbyGroups(req, res, next) {
    try {
      const latitude = Number(req.query.latitude);
      const longitude = Number(req.query.longitude);
      const radiusMeters = req.query.radiusMeters ? Number(req.query.radiusMeters) : 10000;

      if (isNaN(latitude) || isNaN(longitude)) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_COORDINATES',
            message: 'As coordenadas latitude e longitude são obrigatórias e devem ser números válidos.'
          }
        });
      }

      const paginationParams = calculatePaginationParams(req.query);
      const searchParams = {
        latitude,
        longitude,
        radiusMeters,
        filters: {
          frequency: req.query.frequency,
          minAmount: req.query.minAmount ? Number(req.query.minAmount) : undefined,
          maxAmount: req.query.maxAmount ? Number(req.query.maxAmount) : undefined
        }
      };

      const result = await locationsService.searchNearbyGroups(req.user, searchParams, paginationParams);

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
   * Lista as províncias angolanas que possuem grupos de Kixikila em atividade.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listActiveProvinces(req, res, next) {
    try {
      const provinces = await locationsService.listActiveProvinces();

      return res.status(200).json({
        success: true,
        data: {
          provinces
        }
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Lista os municípios de determinada província com grupos de Kixikila ativos.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async listMunicipalitiesByProvince(req, res, next) {
    try {
      const province = req.params.province || req.query.province;
      const municipalities = await locationsService.listMunicipalitiesByProvince(province);

      return res.status(200).json({
        success: true,
        data: {
          province,
          municipalities
        }
      });
    } catch (error) {
      return next(error);
    }
  }
}

// Instância singleton do controlador com vinculação de contexto
const locationsController = new LocationsController();
locationsController.updateGroupLocation = locationsController.updateGroupLocation.bind(locationsController);
locationsController.getGroupLocation = locationsController.getGroupLocation.bind(locationsController);
locationsController.searchNearbyGroups = locationsController.searchNearbyGroups.bind(locationsController);
locationsController.listActiveProvinces = locationsController.listActiveProvinces.bind(locationsController);
locationsController.listMunicipalitiesByProvince = locationsController.listMunicipalitiesByProvince.bind(locationsController);

module.exports = locationsController;