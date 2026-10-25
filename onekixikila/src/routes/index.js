const express = require('express');
const apiRoutes = require('./api.routes');
const webRoutes = require('./web.routes');
const healthRoutes = require('./health.routes');
const appConfig = require('../config/app');

const router = express.Router();

/**
 * Sonda direta de integridade e prontidão operacional (/api/health)
 * Atende com prioridade aos health checks do balanceador de carga do Render configurados no render.yaml
 */
router.use('/api/health', healthRoutes);
router.use('/health', healthRoutes);

/**
 * Roteamento da API REST versionada (/api/v1) e compatibilidade com chamadas (/api)
 */
router.use(appConfig.apiPrefix, apiRoutes);
router.use('/api', apiRoutes);

/**
 * Roteamento web principal e renderização server-side de templates EJS (/)
 */
router.use('/', webRoutes);

module.exports = router;