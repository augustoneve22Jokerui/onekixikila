/**
 * Middleware para captura de rotas e recursos não encontrados (HTTP 404).
 * Executado ao final da cadeia de rotas quando nenhuma rota correspondente é localizada.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
const notFoundHandler = (req, res, next) => {
  const requestId = req.id || 'N/A';
  const isApiRequest = req.originalUrl.startsWith('/api/') || req.xhr || !req.accepts('html');

  if (isApiRequest) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: `O recurso [${req.method} ${req.originalUrl}] não foi encontrado na plataforma OneKixikila.`,
        requestId
      }
    });
  }

  return res.status(404).render('errors/404', {
    title: 'Página Não Encontrada',
    message: 'A página solicitada não existe ou foi movida.',
    statusCode: 404,
    requestId
  });
};

module.exports = notFoundHandler;