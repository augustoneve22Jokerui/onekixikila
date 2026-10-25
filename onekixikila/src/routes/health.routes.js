const express = require('express');
const healthController = require('../modules/health/health.controller');

const router = express.Router();

/**
 * @route   GET /
 * @desc    Sonda principal de prontidão para o health check do Render (/api/health)
 * @access  Público
 */
router.get('/', healthController.getReadiness);

/**
 * @route   GET /liveness
 * @desc    Sonda rápida de vivacidade do processo Node.js e event loop
 * @access  Público
 */
router.get('/liveness', healthController.getLiveness);

/**
 * @route   GET /readiness
 * @desc    Sonda explícita de prontidão operacional com verificação de banco de dados
 * @access  Público
 */
router.get('/readiness', healthController.getReadiness);

/**
 * @route   GET /diagnostics
 * @desc    Métricas diagnósticas detalhadas de memória, pool e armazenamento
 * @access  Público / Monitorização interna
 */
router.get('/diagnostics', healthController.getDiagnostics);

module.exports = router;