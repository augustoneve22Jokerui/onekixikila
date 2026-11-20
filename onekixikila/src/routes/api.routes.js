// =============================================================================
// routes/api.routes.js
// =============================================================================

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

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/groups', groupRoutes);
router.use('/wallet', walletRoutes);
router.use('/payments', paymentRoutes);
router.use('/chat', chatRoutes);
router.use('/documents', documentRoutes);
router.use('/identity', identityModuleRoutes);
router.use('/notifications', notificationRoutes);
router.use('/admin', adminRoutes);

module.exports = router;