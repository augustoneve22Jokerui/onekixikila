const express = require('express');
const authModuleRoutes = require('../modules/auth/auth.routes');

const router = express.Router();

/**
 * Ponto de entrada de roteamento para os endpoints de Autenticação e Gestão de Contas.
 * Delega o tratamento das rotas (/register, /login, /verify-otp, /forgot-password,
 * /reset-password, /refresh-token, /change-password, /logout, /me) para o módulo auth.
 */
router.use('/', authModuleRoutes);

module.exports = router;