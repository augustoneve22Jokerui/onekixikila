const crypto = require('crypto');
const { queryOne, query } = require('../database/query');

/**
 * Calcula o hash SHA-256 do corpo da requisição para verificar integridade da chamada idempotente.
 * @param {any} body
 * @returns {string}
 */
const calculateRequestHash = (body) => {
  const content = body ? JSON.stringify(body) : '';
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
};

/**
 * Middleware para garantia de idempotência em transações financeiras e mutações de saldo.
 * Previne execuções duplicadas acidentais (double-spending) em caso de quedas de rede móvel ou múltiplos cliques.
 *
 * @param {object} [options]
 * @param {boolean} [options.required=false] - Se a chave de idempotência é mandatória na rota
 * @param {number} [options.lockTimeoutSeconds=120] - Tempo de bloqueio durante o processamento
 * @returns {import('express').RequestHandler}
 */
const idempotency = (options = {}) => {
  const { required = false, lockTimeoutSeconds = 120 } = options;

  return async (req, res, next) => {
    // 1. Extração do cabeçalho de idempotência padronizado
    const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];

    if (!idempotencyKey) {
      if (required) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'IDEMPOTENCY_KEY_REQUIRED',
            message: 'O cabeçalho Idempotency-Key é obrigatório para esta operação financeira.'
          }
        });
      }
      return next();
    }

    const userId = req.user ? req.user.id : null;
    const routePath = req.originalUrl || req.path;
    const httpMethod = req.method;
    const requestHash = calculateRequestHash(req.body);

    try {
      // 2. Consulta existência de chave prévia
      const checkQuery = `
        SELECT id, key, status, request_hash, response_code, response_body, locked_until
        FROM idempotency_keys
        WHERE key = $1;
      `;
      const existing = await queryOne(checkQuery, [idempotencyKey]);

      if (existing) {
        // Validação de divergência de carga: a mesma chave não pode ser usada com corpo diferente
        if (existing.request_hash !== requestHash) {
          return res.status(422).json({
            success: false,
            error: {
              code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
              message: 'Esta chave de idempotência já foi utilizada com dados diferentes.'
            }
          });
        }

        // Operação ainda em processamento dentro da janela de lock
        if (existing.status === 'PROCESSING' && new Date(existing.locked_until) > new Date()) {
          return res.status(409).json({
            success: false,
            error: {
              code: 'CONCURRENT_REQUEST_IN_PROGRESS',
              message: 'Esta operação financeira já se encontra em processamento. Aguarde a confirmação.'
            }
          });
        }

        // Operação concluída com sucesso: devolve imediatamente a resposta em cache (Anti-replay)
        if (existing.status === 'COMPLETED' && existing.response_code) {
          res.setHeader('X-Cache-Lookup', 'HIT-IDEMPOTENT');
          return res.status(existing.response_code).json(existing.response_body);
        }
      }

      // 3. Regista o lock inicial de processamento
      const insertLockQuery = `
        INSERT INTO idempotency_keys (
          key, user_id, route_path, http_method, request_hash, status, locked_until
        )
        VALUES ($1, $2, $3, $4, $5, 'PROCESSING', (NOW() AT TIME ZONE 'UTC') + ($6 || ' seconds')::interval)
        ON CONFLICT (key) DO UPDATE
        SET status = 'PROCESSING',
            locked_until = (NOW() AT TIME ZONE 'UTC') + ($6 || ' seconds')::interval,
            updated_at = NOW() AT TIME ZONE 'UTC';
      `;

      await query(insertLockQuery, [
        idempotencyKey,
        userId,
        routePath,
        httpMethod,
        requestHash,
        lockTimeoutSeconds
      ]);

      // 4. Interceta o envio da resposta para gravar o resultado no banco
      const originalJson = res.json.bind(res);

      res.json = (body) => {
        const statusCode = res.statusCode;
        const finalStatus = statusCode < 500 ? 'COMPLETED' : 'FAILED';

        // Atualização assíncrona pós-resposta
        query(
          `UPDATE idempotency_keys
           SET status = $1,
               response_code = $2,
               response_body = $3,
               updated_at = NOW() AT TIME ZONE 'UTC'
           WHERE key = $4;`,
          [finalStatus, statusCode, JSON.stringify(body), idempotencyKey]
        ).catch((err) => {
          console.error('[IDEMPOTENCY:ERROR] Falha ao salvar resposta de idempotência:', err.message);
        });

        return originalJson(body);
      };

      return next();
    } catch (error) {
      console.error('[IDEMPOTENCY:FATAL] Erro no middleware de idempotência:', error.message);
      return next(error);
    }
  };
};

module.exports = idempotency;