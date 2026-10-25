const { queryOne } = require('../database/query');

/**
 * Middleware para autorização baseada em funções globais (Role-Based Access Control - RBAC).
 * Verifica se o utilizador autenticado possui pelo menos uma das funções autorizadas.
 *
 * @param {...string} allowedRoles - Lista de papéis permitidos (ex: 'ADMIN', 'GROUP_LEADER', 'MEMBER')
 * @returns {import('express').RequestHandler}
 */
const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Autenticação prévia obrigatória antes da verificação de autorização.'
        }
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: `Acesso negado. A sua função [${req.user.role}] não possui permissão para este recurso.`
        }
      });
    }

    return next();
  };
};

/**
 * Middleware para verificação de filiação e autorização no contexto de um Grupo de Kixikila (Anti-BOLA/IDOR).
 * Valida se o utilizador autenticado é membro ativo ou líder do grupo especificado na rota.
 *
 * @param {object} [options]
 * @param {string[]} [options.allowedGroupRoles] - Lista de papéis no grupo permitidos (ex: ['PRIMARY_LEADER', 'VICE_LEADER'])
 * @param {boolean} [options.requireActiveStatus=true] - Se exige estado estritamente 'ACTIVE'
 * @param {string} [options.paramName='groupId'] - Nome do parâmetro na rota com o identificador do grupo
 * @returns {import('express').RequestHandler}
 */
const requireGroupMembership = (options = {}) => {
  const {
    allowedGroupRoles = [],
    requireActiveStatus = true,
    paramName = 'groupId'
  } = options;

  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Autenticação necessária.'
          }
        });
      }

      const groupId = req.params[paramName] || req.body[paramName];

      if (!groupId) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_GROUP_IDENTIFIER',
            message: `Identificador do grupo [${paramName}] não fornecido na requisição.`
          }
        });
      }

      // Administradores globais têm permissão de auditoria e intervenção justificada
      if (req.user.role === 'ADMIN') {
        req.groupContext = {
          groupId,
          role: 'ADMIN_SUPERVISOR',
          status: 'ACTIVE',
          isLeader: false
        };
        return next();
      }

      const membershipQuery = `
        SELECT 
          m.id AS membership_id,
          m.group_id,
          m.user_id,
          m.role,
          m.status,
          m.is_banned_from_chat,
          m.is_contribution_restricted,
          m.is_payout_restricted,
          g.leader_id,
          (g.leader_id = m.user_id) AS is_primary_leader
        FROM group_memberships m
        INNER JOIN groups g ON g.id = m.group_id
        WHERE m.group_id = $1 AND m.user_id = $2;
      `;

      const membership = await queryOne(membershipQuery, [groupId, req.user.id]);

      if (!membership) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'NOT_A_GROUP_MEMBER',
            message: 'Não possui vínculo de filiação com este grupo de Kixikila.'
          }
        });
      }

      if (requireActiveStatus && membership.status !== 'ACTIVE') {
        return res.status(403).json({
          success: false,
          error: {
            code: 'MEMBERSHIP_NOT_ACTIVE',
            message: `O seu estado no grupo é [${membership.status}]. Ação não permitida.`
          }
        });
      }

      if (allowedGroupRoles.length > 0 && !allowedGroupRoles.includes(membership.role) && !membership.is_primary_leader) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'UNAUTHORIZED_GROUP_ACTION',
            message: 'Ação reservada apenas à liderança ou cargos específicos do grupo.'
          }
        });
      }

      // Disponibiliza o contexto da filiação para o controlador
      req.groupContext = Object.freeze({
        membershipId: membership.membership_id,
        groupId: membership.group_id,
        role: membership.role,
        status: membership.status,
        isLeader: Boolean(membership.is_primary_leader || membership.role === 'VICE_LEADER'),
        isBannedFromChat: membership.is_banned_from_chat,
        isContributionRestricted: membership.is_contribution_restricted,
        isPayoutRestricted: membership.is_payout_restricted
      });

      return next();
    } catch (error) {
      return next(error);
    }
  };
};

/**
 * Middleware para garantir titularidade de recursos pessoais (Anti-IDOR).
 * Valida se o utilizador que está a requisitar é o proprietário do identificador na rota.
 *
 * @param {string} [paramName='userId'] - Nome do parâmetro na rota
 * @returns {import('express').RequestHandler}
 */
const requireSelfOrAdmin = (paramName = 'userId') => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHENTICATED', message: 'Autenticação necessária.' }
      });
    }

    const targetUserId = req.params[paramName];

    if (req.user.role === 'ADMIN' || req.user.id === targetUserId) {
      return next();
    }

    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN_RESOURCE_ACCESS',
        message: 'Não possui autorização para aceder ou modificar recursos de outro utilizador.'
      }
    });
  };
};

module.exports = {
  authorize,
  requireGroupMembership,
  requireSelfOrAdmin
};