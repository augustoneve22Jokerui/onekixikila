const { ZodError } = require('zod');

/**
 * Formata os erros do Zod num array limpo e compreensível para a API.
 * @param {ZodError} error
 * @returns {Array<{ field: string, message: string }>}
 */
const formatZodIssues = (error) => {
  return error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message
  }));
};

/**
 * Middleware de validação schema-driven para requisições HTTP utilizando Zod.
 * Valida e higieniza body, query e params, impedindo ataques de mass assignment.
 *
 * @param {object|import('zod').ZodSchema} schemaOrMap - Schema Zod individual (para req.body) ou mapa { body, query, params }
 * @returns {import('express').RequestHandler}
 */
const validate = (schemaOrMap) => {
  return async (req, res, next) => {
    try {
      // Se for passado um schema Zod direto, valida req.body
      if (typeof schemaOrMap.parseAsync === 'function') {
        req.body = await schemaOrMap.parseAsync(req.body);
        return next();
      }

      // Caso seja um mapa de schemas ({ body, query, params })
      const { body, query, params } = schemaOrMap;

      if (body) {
        req.body = await body.parseAsync(req.body);
      }

      if (query) {
        req.query = await query.parseAsync(req.query);
      }

      if (params) {
        req.params = await params.parseAsync(req.params);
      }

      return next();
    } catch (error) {
      if (error instanceof ZodError) {
        const issues = formatZodIssues(error);

        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Dados de entrada inválidos ou mal formatados.',
            details: issues
          }
        });
      }

      return next(error);
    }
  };
};

/**
 * Validador específico para o corpo (req.body).
 * @param {import('zod').ZodSchema} schema
 */
const validateBody = (schema) => validate({ body: schema });

/**
 * Validador específico para parâmetros de consulta na URL (req.query).
 * @param {import('zod').ZodSchema} schema
 */
const validateQuery = (schema) => validate({ query: schema });

/**
 * Validador específico para parâmetros da rota (req.params).
 * @param {import('zod').ZodSchema} schema
 */
const validateParams = (schema) => validate({ params: schema });

module.exports = {
  validate,
  validateBody,
  validateQuery,
  validateParams
};