const express = require('express');
const documentsModuleRoutes = require('../modules/documents/documents.routes');
const identityModuleRoutes = require('../modules/identity/identity.routes');

const router = express.Router();

/**
 * Ponto de entrada de roteamento para o módulo de Documentos Privados e Identidade (KYC).
 * Centraliza e delega:
 * 1. Documentos privados, contratos e anexos de grupos de Kixikila (com teto estrito de 5 MB e bucket privado 'documentos');
 * 2. Processos de verificação de identidade oficial (KYC - Bilhete de Identidade angolano, passaporte, carta e fotografia facial).
 */
router.use('/identity', identityModuleRoutes);
router.use('/', documentsModuleRoutes);

module.exports = router;