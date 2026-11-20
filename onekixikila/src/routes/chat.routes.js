const express = require('express');
const chatModuleRoutes = require('../modules/chat/chat.routes');

const router = express.Router();

/**
 * Ponto de entrada de roteamento para o módulo de Chat e Comunicação em Grupo.
 * Delega o tratamento de mensagens de texto, notas de voz gravadas, documentos anexos
 * com imposição estrita do limite de 5 MB (5.242.880 bytes), avisos fixados, confirmações
 * de leitura e moderação comunitária para o submódulo especializado de chat.
 */
router.use('/', chatModuleRoutes);

module.exports = router;