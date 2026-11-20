const { z } = require('zod');
const appConfig = require('../../config/app');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = appConfig.pagination.defaultLimit || 20;
const MAX_LIMIT = appConfig.pagination.maxLimit || 100;

/**
 * Esquema de validação para parâmetros de paginação via query string HTTP.
 * Faz a coerção de strings numéricas e impõe limites seguros para prevenir ataques de negação de serviço (DoS).
 */
const paginationQuerySchema = z.object({
  page: z.coerce
    .number()
    .int({ message: 'O número da página deve ser um inteiro.' })
    .positive({ message: 'O número da página deve ser maior ou igual a 1.' })
    .default(DEFAULT_PAGE),

  limit: z.coerce
    .number()
    .int({ message: 'O limite por página deve ser um inteiro.' })
    .positive({ message: 'O limite deve ser maior que zero.' })
    .max(MAX_LIMIT, { message: `O limite máximo permitido por página é de ${MAX_LIMIT} registos.` })
    .default(DEFAULT_LIMIT),

  order: z
    .string()
    .trim()
    .toUpperCase()
    .refine((val) => val === 'ASC' || val === 'DESC', {
      message: "A ordenação deve ser estritamente 'ASC' (ascendente) ou 'DESC' (descendente)."
    })
    .default('DESC'),

  sort_by: z
    .string()
    .trim()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, {
      message: 'Nome de coluna de ordenação contém caracteres inválidos.'
    })
    .optional(),

  search: z
    .string()
    .trim()
    .max(100, { message: 'O termo de pesquisa não pode exceder 100 caracteres.' })
    .optional()
});

/**
 * Converte parâmetros de paginação validados nos valores prontos para SQL (LIMIT e OFFSET).
 *
 * @param {object} query - Objeto validado pelo paginationQuerySchema
 * @returns {{
 *   page: number,
 *   limit: number,
 *   offset: number,
 *   order: 'ASC'|'DESC',
 *   sortBy: string|null,
 *   search: string|null
 * }}
 */
const calculatePaginationParams = (query = {}) => {
  const parsed = paginationQuerySchema.parse(query);

  const page = parsed.page;
  const limit = parsed.limit;
  const offset = (page - 1) * limit;

  return {
    page,
    limit,
    offset,
    order: parsed.order,
    sortBy: parsed.sort_by || null,
    search: parsed.search && parsed.search.length > 0 ? parsed.search : null
  };
};

/**
 * Cria um esquema Zod de ordenação com lista estrita de colunas permitidas (Whitelist)
 * para proteção contra injeções SQL em cláusulas ORDER BY dinâmicas.
 *
 * @param {string[]} allowedColumns - Array de nomes de colunas permitidos
 * @param {string} [defaultColumn='created_at'] - Coluna padrão
 * @returns {import('zod').ZodSchema}
 */
const createSortSchema = (allowedColumns = ['created_at'], defaultColumn = 'created_at') => {
  return z
    .string()
    .trim()
    .refine((col) => allowedColumns.includes(col), {
      message: `Coluna de ordenação não permitida. Colunas aceites: ${allowedColumns.join(', ')}.`
    })
    .default(defaultColumn);
};

/**
 * Formata os metadados e o conteúdo de uma resposta paginada padronizada para as APIs.
 *
 * @param {object} params
 * @param {Array<any>} params.data - Lista de registos da página atual
 * @param {number} params.totalCount - Total geral de registos no banco de dados
 * @param {number} params.page - Página atual
 * @param {number} params.limit - Quantidade de itens por página
 * @returns {{
 *   data: Array<any>,
 *   pagination: {
 *     currentPage: number,
 *     pageSize: number,
 *     totalItems: number,
 *     totalPages: number,
 *     hasNextPage: boolean,
 *     hasPrevPage: boolean
 *   }
 * }}
 */
const formatPaginatedResult = ({ data, totalCount, page, limit }) => {
  const safeTotal = Math.max(Number(totalCount) || 0, 0);
  const totalPages = safeTotal > 0 ? Math.ceil(safeTotal / limit) : 1;

  return {
    data: data || [],
    pagination: {
      currentPage: page,
      pageSize: limit,
      totalItems: safeTotal,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  };
};

module.exports = {
  paginationQuerySchema,
  calculatePaginationParams,
  createSortSchema,
  formatPaginatedResult
};