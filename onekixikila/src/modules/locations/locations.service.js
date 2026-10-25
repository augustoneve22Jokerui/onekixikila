const locationsRepository = require('./locations.repository');
const locationsPolicy = require('./locations.policy');
const groupsRepository = require('../groups/groups.repository');
const { formatPaginatedResult } = require('../../shared/validation/pagination');
const AuthorizationError = require('../../shared/errors/authorization-error');
const NotFoundError = require('../../shared/errors/not-found-error');
const ValidationError = require('../../shared/errors/validation-error');

/**
 * Serviço de regras de negócio para Geolocalização, Descoberta Territorial
 * e Divisão Administrativa de Angola nos Grupos de Kixikila.
 */
class LocationsService {
  /**
   * Configura ou atualiza a localização territorial aproximada do grupo de Kixikila.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {string} groupId - UUID do grupo
   * @param {object} locationData - Dados territoriais e coordenadas
   * @param {object} [context={}]
   * @returns {Promise<object>}
   */
  async updateGroupLocation(actingUser, groupId, locationData, context = {}) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const permissionCheck = locationsPolicy.canManageLocation(actingUser, group);
    if (!permissionCheck.allowed) {
      throw new AuthorizationError(permissionCheck.reason);
    }

    const {
      province,
      municipality,
      neighborhood = null,
      referencePoint = null,
      approximateLatitude = null,
      approximateLongitude = null,
      radiusMeters = 5000,
      isPubliclyDiscoverable = true
    } = locationData;

    // Se informadas coordenadas, valida a sua consistência esférica
    if (approximateLatitude !== null && approximateLongitude !== null) {
      if (!locationsPolicy.isValidCoordinates(approximateLatitude, approximateLongitude)) {
        throw ValidationError.invalidFormat(
          'approximateLatitude/approximateLongitude',
          'Coordenadas geográficas válidas (Latitude entre -90 e 90, Longitude entre -180 e 180)'
        );
      }
    }

    const radiusCheck = locationsPolicy.validateRadius(radiusMeters);
    const sanitizedRadius = radiusCheck.sanitizedRadius;

    const updated = await locationsRepository.upsertGroupLocation({
      groupId,
      province,
      municipality,
      neighborhood,
      referencePoint,
      approximateLatitude,
      approximateLongitude,
      radiusMeters: sanitizedRadius,
      isPubliclyDiscoverable
    });

    if (context.recordAudit) {
      await context.recordAudit({
        action: 'UPDATE',
        resourceType: 'GROUP_LOCATION',
        resourceId: groupId,
        newValues: {
          province,
          municipality,
          radiusMeters: sanitizedRadius,
          isPubliclyDiscoverable
        }
      });
    }

    return updated;
  }

  /**
   * Consulta os dados de localização de determinado grupo.
   * Aplica salvaguarda de privacidade caso o requerente não pertença à liderança do grupo ou à administração.
   *
   * @param {object} actingUser
   * @param {string} groupId
   * @returns {Promise<object>}
   */
  async getGroupLocation(actingUser, groupId) {
    const group = await groupsRepository.findById(groupId);
    if (!group) {
      throw NotFoundError.group(groupId);
    }

    const location = await locationsRepository.findByGroupId(groupId);
    if (!location) {
      throw NotFoundError.resource('Localização do Grupo', groupId);
    }

    const isLeader = actingUser && (actingUser.id === group.leader_id || actingUser.role === 'ADMIN');
    if (!isLeader) {
      return locationsPolicy.sanitizeLocationForPublic(location);
    }

    return location;
  }

  /**
   * Realiza a pesquisa geoespacial de grupos abertos próximos por coordenadas esféricas em Angola.
   *
   * @param {object} actingUser
   * @param {object} searchParams - { latitude, longitude, radiusMeters, filters }
   * @param {object} paginationParams - { page, limit, offset }
   * @returns {Promise<object>}
   */
  async searchNearbyGroups(actingUser, searchParams, paginationParams) {
    const { latitude, longitude, radiusMeters, filters = {} } = searchParams;

    if (!locationsPolicy.isValidCoordinates(latitude, longitude)) {
      throw ValidationError.invalidFormat('latitude/longitude', 'Coordenadas de busca inválidas.');
    }

    const radiusCheck = locationsPolicy.validateRadius(radiusMeters);
    const safeRadius = radiusCheck.sanitizedRadius;

    const { limit, offset, page } = paginationParams;

    const rows = await locationsRepository.searchGroupsByDistance({
      latitude,
      longitude,
      radiusMeters: safeRadius,
      limit,
      offset,
      filters
    });

    const totalCount = await locationsRepository.countNearbyGroups({
      latitude,
      longitude,
      radiusMeters: safeRadius,
      filters
    });

    return formatPaginatedResult({
      data: rows,
      totalCount,
      page,
      limit
    });
  }

  /**
   * Lista as províncias angolanas que possuem grupos de Kixikila em atividade para navegação territorial.
   *
   * @returns {Promise<Array<object>>}
   */
  async listActiveProvinces() {
    return locationsRepository.listActiveProvinces();
  }

  /**
   * Lista os municípios de determinada província com grupos em atividade.
   *
   * @param {string} province - Nome da província (ex: 'Luanda', 'Benguela', 'Huíla')
   * @returns {Promise<Array<object>>}
   */
  async listMunicipalitiesByProvince(province) {
    if (!province || typeof province !== 'string') {
      throw ValidationError.fieldRequired('province');
    }

    return locationsRepository.listMunicipalitiesByProvince(province.trim());
  }
}

// Instância singleton do serviço de localizações
const locationsService = new LocationsService();

module.exports = locationsService;