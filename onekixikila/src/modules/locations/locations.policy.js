const { USER_ROLES } = require('../../shared/constants/roles');
const { USER_STATUSES, GROUP_STATUSES } = require('../../shared/constants/statuses');

// Limites operacionais de raio para pesquisa geoespacial de grupos
const MIN_RADIUS_METERS = 500;    // 500 metros
const MAX_RADIUS_METERS = 50000;  // 50 quilómetros

/**
 * Políticas de autorização, privacidade e conformidade territorial
 * para o módulo de Localizações e Descoberta de Grupos de Kixikila.
 */
class LocationsPolicy {
  /**
   * Avalia se a liderança do grupo ou administrador possui autorização para atualizar
   * os dados de georreferenciação e descoberta pública do grupo.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} group - Dados cadastrais do grupo
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canManageLocation(actingUser, group) {
    if (!actingUser || !group) {
      return { allowed: false, reason: 'Utilizador ou grupo não identificado.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return { allowed: true };
    }

    if (actingUser.id !== group.leader_id && actingUser.id !== group.creator_id) {
      return {
        allowed: false,
        reason: 'Apenas o Líder titular ou o criador possuem permissão para configurar a localização do grupo.'
      };
    }

    if (group.status === GROUP_STATUSES.COMPLETED || group.status === GROUP_STATUSES.CANCELLED) {
      return {
        allowed: false,
        reason: `Grupos no estado [${group.status}] não podem sofrer alterações territoriais.`
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia a elegibilidade de um raio de varredura informado para busca por proximidade.
   *
   * @param {number} radiusMeters
   * @returns {{ valid: boolean, sanitizedRadius: number, reason?: string }}
   */
  validateRadius(radiusMeters) {
    const radius = Number(radiusMeters) || 10000;

    if (radius < MIN_RADIUS_METERS) {
      return {
        valid: false,
        sanitizedRadius: MIN_RADIUS_METERS,
        reason: `O raio de busca mínimo é de ${MIN_RADIUS_METERS} metros.`
      };
    }

    if (radius > MAX_RADIUS_METERS) {
      return {
        valid: false,
        sanitizedRadius: MAX_RADIUS_METERS,
        reason: `O raio de busca máximo autorizado é de ${MAX_RADIUS_METERS / 1000} km.`
      };
    }

    return { valid: true, sanitizedRadius: radius };
  }

  /**
   * Avalia se as coordenadas geográficas estão dentro dos limites válidos do globo terrestre.
   *
   * @param {number} latitude
   * @param {number} longitude
   * @returns {boolean}
   */
  isValidCoordinates(latitude, longitude) {
    if (typeof latitude !== 'number' || isNaN(latitude) || latitude < -90 || latitude > 90) {
      return false;
    }
    if (typeof longitude !== 'number' || isNaN(longitude) || longitude < -180 || longitude > 180) {
      return false;
    }
    return true;
  }

  /**
   * Avalia se determinado grupo e sua localização são elegíveis para exibição no catálogo público de descoberta.
   *
   * @param {object} groupLocation
   * @param {object} group
   * @returns {boolean}
   */
  isGroupDiscoverable(groupLocation, group) {
    if (!groupLocation || !group) {
      return false;
    }

    if (group.is_private) {
      return false;
    }

    if (!groupLocation.is_publicly_discoverable) {
      return false;
    }

    return group.status === GROUP_STATUSES.FORMATION || group.status === GROUP_STATUSES.ACTIVE;
  }

  /**
   * Aplica salvaguarda de privacidade em registos de localização de grupos para exibição pública.
   * Remove coordenadas geográficas exatas para prevenir monitorização residencial de membros,
   * preservando apenas município, província e distância aproximada.
   *
   * @param {object} locationRecord
   * @returns {object}
   */
  sanitizeLocationForPublic(locationRecord) {
    if (!locationRecord) {
      return null;
    }

    return {
      country: locationRecord.country || 'AGO',
      province: locationRecord.province,
      municipality: locationRecord.municipality,
      neighborhood: locationRecord.neighborhood || null,
      distanceMeters: locationRecord.distance_meters !== undefined ? Number(locationRecord.distance_meters) : undefined
    };
  }
}

// Instância singleton da política de localizações
const locationsPolicy = new LocationsPolicy();

module.exports = locationsPolicy;