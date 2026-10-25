/**
 * Utilitários puros para orquestração de paginação, fatiamento de dados em memória,
 * cálculo de deslocamento SQL (offset) e montagem de metadados de navegação para a plataforma OneKixikila.
 */

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_SAFE_LIMIT = 100;

/**
 * Normaliza e higieniza números de página e limites para faixas seguras.
 *
 * @param {number|string} pageInput
 * @param {number|string} limitInput
 * @returns {{ page: number, limit: number, offset: number }}
 */
const normalizePagination = (pageInput, limitInput) => {
  let page = parseInt(pageInput, 10);
  let limit = parseInt(limitInput, 10);

  if (isNaN(page) || page < 1) {
    page = DEFAULT_PAGE;
  }

  if (isNaN(limit) || limit < 1) {
    limit = DEFAULT_LIMIT;
  } else if (limit > MAX_SAFE_LIMIT) {
    limit = MAX_SAFE_LIMIT;
  }

  const offset = (page - 1) * limit;

  return {
    page,
    limit,
    offset
  };
};

/**
 * Calcula o total de páginas a partir do total de registos e do limite por página.
 *
 * @param {number} totalRecords
 * @param {number} limit
 * @returns {number}
 */
const calculateTotalPages = (totalRecords, limit) => {
  const safeTotal = Math.max(0, parseInt(totalRecords, 10) || 0);
  const safeLimit = Math.max(1, parseInt(limit, 10) || DEFAULT_LIMIT);
  return safeTotal > 0 ? Math.ceil(safeTotal / safeLimit) : 1;
};

/**
 * Fatia um array em memória para paginação de listas estáticas ou relatórios.
 *
 * @template T
 * @param {T[]} items - Array de itens
 * @param {number} [page=1] - Página pretendida
 * @param {number} [limit=20] - Limite de itens por página
 * @returns {{
 *   data: T[],
 *   pagination: {
 *     page: number,
 *     limit: number,
 *     totalItems: number,
 *     totalPages: number,
 *     hasNext: boolean,
 *     hasPrev: boolean
 *   }
 * }}
 */
const paginateArray = (items = [], page = DEFAULT_PAGE, limit = DEFAULT_LIMIT) => {
  const safeItems = Array.isArray(items) ? items : [];
  const normalized = normalizePagination(page, limit);
  const totalItems = safeItems.length;
  const totalPages = calculateTotalPages(totalItems, normalized.limit);

  const startIndex = normalized.offset;
  const endIndex = startIndex + normalized.limit;
  const data = safeItems.slice(startIndex, endIndex);

  return {
    data,
    pagination: {
      page: normalized.page,
      limit: normalized.limit,
      totalItems,
      totalPages,
      hasNext: normalized.page < totalPages,
      hasPrev: normalized.page > 1
    }
  };
};

/**
 * Constrói o envelope estruturado com metadados e hiperligações de navegação (HATEOAS).
 *
 * @param {object} params
 * @param {Array<any>} params.items - Registos obtidos da base de dados
 * @param {number} params.totalCount - Total de linhas existentes na tabela
 * @param {number} params.page - Página solicitada
 * @param {number} params.limit - Tamanho do lote
 * @param {string} [params.baseUrl=''] - URL base para construção de hiperligações de navegação
 * @returns {object} Estrutura de paginação completa
 */
const buildPaginatedEnvelope = ({ items = [], totalCount = 0, page = 1, limit = 20, baseUrl = '' }) => {
  const normalized = normalizePagination(page, limit);
  const totalItems = Math.max(0, parseInt(totalCount, 10) || 0);
  const totalPages = calculateTotalPages(totalItems, normalized.limit);

  const currentPage = normalized.page;
  const currentLimit = normalized.limit;
  const hasNext = currentPage < totalPages;
  const hasPrev = currentPage > 1;

  let links = null;
  if (baseUrl && typeof baseUrl === 'string') {
    const separator = baseUrl.includes('?') ? '&' : '?';
    links = {
      self: `${baseUrl}${separator}page=${currentPage}&limit=${currentLimit}`,
      first: `${baseUrl}${separator}page=1&limit=${currentLimit}`,
      last: `${baseUrl}${separator}page=${totalPages}&limit=${currentLimit}`,
      next: hasNext ? `${baseUrl}${separator}page=${currentPage + 1}&limit=${currentLimit}` : null,
      prev: hasPrev ? `${baseUrl}${separator}page=${currentPage - 1}&limit=${currentLimit}` : null
    };
  }

  return {
    data: items || [],
    pagination: {
      currentPage,
      pageSize: currentLimit,
      totalItems,
      totalPages,
      hasNextPage: hasNext,
      hasPrevPage: hasPrev,
      ...(links ? { links } : {})
    }
  };
};

module.exports = {
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_SAFE_LIMIT,
  normalizePagination,
  calculateTotalPages,
  paginateArray,
  buildPaginatedEnvelope
};