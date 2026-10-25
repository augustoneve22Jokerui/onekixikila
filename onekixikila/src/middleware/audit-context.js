const { query } = require('../database/query');

// Chaves sensíveis que devem ser expurgadas ou redigidas antes da persistência de auditoria
const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'passwordHash',
  'newPassword',
  'oldPassword',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'client_secret',
  'apiKey',
  'signature',
  'cookie',
  'authorization',
  'credit_card',
  'cvv'
]);

/**
 * Higieniza recursivamente objetos e payloads antes da gravação no registo de auditoria.
 * @param {any} data
 * @returns {any}
 */
const sanitizeForAudit = (data) => {
  if (!data || typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(sanitizeForAudit);
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEYS.has(key)) {
      cleaned[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      cleaned[key] = sanitizeForAudit(value);
    } else {
      cleaned[key] = value;
    }
  }

  return cleaned;
};

/**
 * Middleware para anexar o contexto de auditoria e métodos de registo institucional à requisição.
 * Injeta req.auditContext e a função auxiliar req.recordAudit() para controladores e serviços.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const auditContextMiddleware = (req, res, next) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  const ipAddress = (typeof forwardedFor === 'string' ? forwardedFor.split(',')[0].trim() : null) || req.ip || '127.0.0.1';
  const userAgent = req.headers['user-agent'] || 'UNKNOWN';
  const requestId = req.id || req.requestId || 'N/A';

  req.auditContext = {
    requestId,
    ipAddress,
    userAgent
  };

  /**
   * Grava um registo de auditoria imutável na tabela audit_events.
   *
   * @param {object} params
   * @param {string} params.action - Ação canónica (ex: 'CREATE', 'UPDATE', 'FINANCIAL_TRANSACTION', 'ADMIN_ACTION')
   * @param {string} params.resourceType - Tipo de recurso (ex: 'USER', 'WALLET', 'GROUP', 'DISPUTE')
   * @param {string} [params.resourceId] - Identificador do recurso afetado
   * @param {object} [params.oldValues] - Estado anterior
   * @param {object} [params.newValues] - Novo estado
   * @param {object} [params.metadata] - Metadados adicionais
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   */
  req.recordAudit = async (params, client = null) => {
    try {
      const {
        action,
        resourceType,
        resourceId = null,
        oldValues = null,
        newValues = null,
        metadata = {}
      } = params;

      const actorUserId = req.user ? req.user.id : null;
      const actorRole = req.user ? req.user.role : 'ANONYMOUS';

      const sanitizedOld = oldValues ? JSON.stringify(sanitizeForAudit(oldValues)) : null;
      const sanitizedNew = newValues ? JSON.stringify(sanitizeForAudit(newValues)) : null;
      const sanitizedMeta = JSON.stringify(sanitizeForAudit(metadata));

      const insertQuery = `
        INSERT INTO audit_events (
          request_id,
          actor_user_id,
          actor_role,
          ip_address,
          user_agent,
          action,
          resource_type,
          resource_id,
          old_values,
          new_values,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
      `;

      const values = [
        requestId,
        actorUserId,
        actorRole,
        ipAddress,
        userAgent,
        action,
        resourceType,
        resourceId ? String(resourceId) : null,
        sanitizedOld,
        sanitizedNew,
        sanitizedMeta
      ];

      if (client) {
        await client.query(insertQuery, values);
      } else {
        await query(insertQuery, values);
      }
    } catch (auditError) {
      // Falhas no registo de auditoria não devem quebrar o fluxo principal mas são logadas no console do servidor
      console.error('[AUDIT:ERROR] Falha ao persistir evento de auditoria:', auditError.message);
    }
  };

  return next();
};

module.exports = auditContextMiddleware;