const express = require('express');
const usersModuleRoutes = require('../modules/users/users.routes');

const router = express.Router();

/**
 * Ponto de entrada de roteamento para os endpoints de Utilizadores e Perfis.
 * Delega o tratamento das operações cadastrais (/profile, /location, /preferences,
 * /:userId/public, /:userId/role, /:userId/status, /account) para o módulo users.
 */
router.use('/', usersModuleRoutes);

module.exports = router;