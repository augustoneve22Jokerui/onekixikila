const express = require('express');
const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const groupRoutes = require('./group.routes');
const walletRoutes = require('./wallet.routes');
const paymentRoutes = require('./payment.routes');
const chatRoutes = require('./chat.routes');
const documentRoutes = require('./document.routes');
const notificationRoutes = require('./notification.routes');
const adminRoutes = require('./admin.routes');
const healthRoutes = require('./health.routes');
const identityModuleRoutes = require('../modules/identity/identity.routes');
const { standardLimiter } = require('../middleware/rate-limit');
const appConfig = require('../config/app');

const router = express.Router();

// Aplica limitação padrão de taxa a todos os endpoints da API REST
router.use(standardLimiter);

/**
 * @route   GET /
 * @desc    Metadados de identificação, versão e estado operacional da API REST
 * @access  Público
 */
router.get('/', (req, res) => {
  return res.status(200).json({
    success: true,
    service: appConfig.name,
    version: '1.0.0',
    environment: appConfig.env,
    currency: appConfig.currency,
    timestamp: new Date().toISOString(),
    documentation: '/docs',
    endpoints: {
      health: '/api/v1/health',
      auth: '/api/v1/auth',
      users: '/api/v1/users',
      groups: '/api/v1/groups',
      wallet: '/api/v1/wallet',
      payments: '/api/v1/payments',
      chat: '/api/v1/chat',
      documents: '/api/v1/documents',
      identity: '/api/v1/identity',
      notifications: '/api/v1/notifications',
      admin: '/api/v1/admin'
    }
  });
});

// -----------------------------------------------------------------------------
// VINCULAÇÃO DOS MÓDULOS CANÓNICOS DA API REST
// -----------------------------------------------------------------------------

// Sondas de integridade e vivacidade (Liveness e Readiness para Render)
router.use('/health', healthRoutes);

// Autenticação, registo, login, OTP e recuperação de credenciais
router.use('/auth', authRoutes);

// Gestão de utilizadores, perfis, localização geográfica e preferências
router.use('/users', userRoutes);

// Grupos de Kixikila, quotas, calendários, rotações, liderança e convites
router.use('/groups', groupRoutes);

// Carteira digital, saldos em Kwanzas (AOA), depósitos, levantamentos e transferências P2P
router.use('/wallet', walletRoutes);

// Checkout externo, webhooks (Multicaixa Express, Unitel Money, e-Kwanza), pagamentos e conciliação
router.use('/payments', paymentRoutes);

// Comunicação em grupo, mensagens de texto, notas de voz, anexos de até 5 MB e moderação
router.use('/chat', chatRoutes);

// Documentos confidenciais, cofre privado e upload com inspeção binária
router.use('/documents', documentRoutes);

// Esteira de identificação oficial e conformidade KYC (Bilhete de Identidade e fotos faciais)
router.use('/identity', identityModuleRoutes);

// Notificações multicanal (In-App, SMS, Email e Push) e confirmação de leitura
router.use('/notifications', notificationRoutes);

// Governança administrativa, relatórios executivos, disputas, tarifas, limites e motor de risco
router.use('/admin', adminRoutes);

module.exports = router;