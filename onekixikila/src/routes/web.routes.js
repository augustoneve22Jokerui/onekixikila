const express = require('express');
const { authenticate, authenticateOptional } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
const csrfProtection = require('../middleware/csrf');
const appConfig = require('../config/app');

const router = express.Router();

// Aplica proteção CSRF a todas as rotas web baseadas em cookies de sessão
router.use(csrfProtection);

// Middleware para disponibilizar metadados globais da aplicação às views EJS
router.use((req, res, next) => {
  res.locals.appName = appConfig.name;
  res.locals.currentYear = new Date().getFullYear();
  res.locals.currency = appConfig.currency;
  res.locals.user = req.user || null;
  res.locals.path = req.path;
  next();
});

// -----------------------------------------------------------------------------
// 1. PÁGINAS PÚBLICAS E AUTENTICAÇÃO
// -----------------------------------------------------------------------------

/**
 * @route   GET /
 * @desc    Página inicial da plataforma OneKixikila (redireciona para o painel se autenticado)
 */
router.get('/', authenticateOptional, (req, res) => {
  if (req.user) {
    return res.redirect('/dashboard');
  }
  return res.render('auth/login', {
    title: 'Iniciar Sessão — OneKixikila',
    layout: 'layouts/auth'
  });
});

/**
 * @route   GET /login
 * @desc    Formulário de início de sessão
 */
router.get('/login', authenticateOptional, (req, res) => {
  if (req.user) {
    return res.redirect('/dashboard');
  }
  return res.render('auth/login', {
    title: 'Iniciar Sessão — OneKixikila',
    layout: 'layouts/auth'
  });
});

/**
 * @route   GET /register
 * @desc    Formulário de criação de conta
 */
router.get('/register', authenticateOptional, (req, res) => {
  if (req.user) {
    return res.redirect('/dashboard');
  }
  return res.render('auth/register', {
    title: 'Criar Conta — OneKixikila',
    layout: 'layouts/auth'
  });
});

/**
 * @route   GET /verify-account
 * @desc    Página para introdução do código OTP de confirmação de conta
 */
router.get('/verify-account', authenticateOptional, (req, res) => {
  return res.render('auth/verify-account', {
    title: 'Verificar Conta — OneKixikila',
    layout: 'layouts/auth',
    type: req.query.type || 'PHONE',
    identifier: req.query.identifier || ''
  });
});

/**
 * @route   GET /forgot-password
 * @desc    Página para solicitação de recuperação de credenciais
 */
router.get('/forgot-password', authenticateOptional, (req, res) => {
  return res.render('auth/forgot-password', {
    title: 'Recuperar Palavra-passe — OneKixikila',
    layout: 'layouts/auth'
  });
});

/**
 * @route   GET /reset-password
 * @desc    Formulário para redefinição de palavra-passe com token
 */
router.get('/reset-password', authenticateOptional, (req, res) => {
  return res.render('auth/reset-password', {
    title: 'Nova Palavra-passe — OneKixikila',
    layout: 'layouts/auth',
    token: req.query.token || ''
  });
});

/**
 * @route   GET /change-password
 * @desc    Formulário autenticado de alteração de palavra-passe
 */
router.get('/change-password', authenticate, (req, res) => {
  return res.render('auth/change-password', {
    title: 'Alterar Palavra-passe — OneKixikila',
    layout: 'layouts/main'
  });
});

// -----------------------------------------------------------------------------
// 2. PAINEL DO UTILIZADOR (Dashboard)
// -----------------------------------------------------------------------------

/**
 * @route   GET /dashboard
 * @desc    Painel principal com visão geral de grupos, saldo e compromissos
 */
router.get('/dashboard', authenticate, (req, res) => {
  return res.render('dashboard/index', {
    title: 'O Meu Painel — OneKixikila',
    layout: 'layouts/main'
  });
});

/**
 * @route   GET /profile
 * @desc    Visualização e edição do perfil de utilizador e preferências
 */
router.get('/profile', authenticate, (req, res) => {
  return res.render('dashboard/profile', {
    title: 'O Meu Perfil — OneKixikila',
    layout: 'layouts/main'
  });
});

/**
 * @route   GET /notifications
 * @desc    Central de notificações e histórico de alertas
 */
router.get('/notifications', authenticate, (req, res) => {
  return res.render('dashboard/notifications', {
    title: 'Notificações — OneKixikila',
    layout: 'layouts/main'
  });
});

/**
 * @route   GET /sessions
 * @desc    Gestão de sessões ativas e dispositivos conectados
 */
router.get('/sessions', authenticate, (req, res) => {
  return res.render('dashboard/sessions', {
    title: 'Dispositivos e Sessões — OneKixikila',
    layout: 'layouts/main'
  });
});

// -----------------------------------------------------------------------------
// 3. GRUPOS DE KIXIKILA
// -----------------------------------------------------------------------------

/**
 * @route   GET /groups
 * @desc    Exploração de grupos públicos, pesquisa por província e os meus grupos
 */
router.get('/groups', authenticate, (req, res) => {
  return res.render('groups/index', {
    title: 'Grupos de Kixikila — OneKixikila',
    layout: 'layouts/main'
  });
});

/**
 * @route   GET /groups/create
 * @desc    Formulário para fundar um novo grupo de Kixikila
 */
router.get('/groups/create', authenticate, (req, res) => {
  return res.render('groups/create', {
    title: 'Criar Grupo de Kixikila — OneKixikila',
    layout: 'layouts/main'
  });
});

/**
 * @route   GET /groups/:groupId
 * @desc    Página de detalhes e regras do grupo
 */
router.get('/groups/:groupId', authenticate, (req, res) => {
  return res.render('groups/details', {
    title: 'Detalhes do Grupo — OneKixikila',
    layout: 'layouts/main',
    groupId: req.params.groupId
  });
});

/**
 * @route   GET /groups/:groupId/members
 * @desc    Membros participantes e turnos do grupo
 */
router.get('/groups/:groupId/members', authenticate, (req, res) => {
  return res.render('groups/members', {
    title: 'Membros do Grupo — OneKixikila',
    layout: 'layouts/main',
    groupId: req.params.groupId
  });
});

/**
 * @route   GET /groups/:groupId/rules
 * @desc    Regulamento interno operacional e termos do grupo
 */
router.get('/groups/:groupId/rules', authenticate, (req, res) => {
  return res.render('groups/rules', {
    title: 'Regras do Grupo — OneKixikila',
    layout: 'layouts/main',
    groupId: req.params.groupId
  });
});

/**
 * @route   GET /groups/:groupId/schedule
 * @desc    Calendário de quotas, rotações e datas de recebimento
 */
router.get('/groups/:groupId/schedule', authenticate, (req, res) => {
  return res.render('groups/schedule', {
    title: 'Calendário de Rotação — OneKixikila',
    layout: 'layouts/main',
    groupId: req.params.groupId
  });
});

/**
 * @route   GET /groups/:groupId/invitations
 * @desc    Gestão de convites e Códigos QR para partilha
 */
router.get('/groups/:groupId/invitations', authenticate, (req, res) => {
  return res.render('groups/invitations', {
    title: 'Convites do Grupo — OneKixikila',
    layout: 'layouts/main',
    groupId: req.params.groupId
  });
});

/**
 * @route   GET /groups/:groupId/chat
 * @desc    Sala de conversação privada do grupo (texto, áudio e documentos)
 */
router.get('/groups/:groupId/chat', authenticate, (req, res) => {
  return res.render('groups/chat', {
    title: 'Chat do Grupo — OneKixikila',
    layout: 'layouts/main',
    groupId: req.params.groupId
  });
});

// -----------------------------------------------------------------------------
// 4. CARTEIRA DIGITAL E FINANÇAS
// -----------------------------------------------------------------------------

/**
 * @route   GET /wallet
 * @desc    Painel da carteira com saldo disponível, retido e opções de movimentação
 */
router.get('/wallet', authenticate, (req, res) => {
  return res.render('wallet/index', {
    title: 'A Minha Carteira — OneKixikila',
    layout: 'layouts/main'
  });
});

/**
 * @route   GET /wallet/statement
 * @desc    Extrato detalhado e histórico contábil de transações
 */
router.get('/wallet/statement', authenticate, (req, res) => {
  return res.render('wallet/statement', {
    title: 'Extrato Financeiro — OneKixikila',
    layout: 'layouts/main'
  });
});

/**
 * @route   GET /wallet/deposit
 * @desc    Página para carregar fundos via Multicaixa Express, Unitel Money ou e-Kwanza
 */
router.get('/wallet/deposit', authenticate, (req, res) => {
  return res.render('wallet/deposit', {
    title: 'Depositar Fundos — OneKixikila',
    layout: 'layouts/main'
  });
});

/**
 * @route   GET /wallet/transfer
 * @desc    Transferência interna direta entre membros (P2P)
 */
router.get('/wallet/transfer', authenticate, (req, res) => {
  return res.render('wallet/transfer', {
    title: 'Transferir Valores — OneKixikila',
    layout: 'layouts/main'
  });
});

/**
 * @route   GET /wallet/withdrawal
 * @desc    Solicitação de levantamento para conta bancária ou carteira móvel
 */
router.get('/wallet/withdrawal', authenticate, (req, res) => {
  return res.render('wallet/withdrawal', {
    title: 'Levantar Fundos — OneKixikila',
    layout: 'layouts/main'
  });
});

/**
 * @route   GET /wallet/receipts
 * @desc    Galeria e consulta de comprovativos emitidos
 */
router.get('/wallet/receipts', authenticate, (req, res) => {
  return res.render('wallet/receipts', {
    title: 'Recibos e Comprovativos — OneKixikila',
    layout: 'layouts/main',
    transactionId: req.query.tx || null
  });
});

// -----------------------------------------------------------------------------
// 5. IDENTIDADE E CONFORMIDADE (KYC)
// -----------------------------------------------------------------------------

/**
 * @route   GET /identity
 * @desc    Painel de identificação e nível de verificação da conta
 */
router.get('/identity', authenticate, (req, res) => {
  return res.render('identity/index', {
    title: 'Verificação de Identidade — OneKixikila',
    layout: 'layouts/main'
  });
});

/**
 * @route   GET /identity/upload
 * @desc    Formulário seguro para envio de Bilhete de Identidade e foto facial
 */
router.get('/identity/upload', authenticate, (req, res) => {
  return res.render('identity/upload-document', {
    title: 'Submeter Documentos — OneKixikila',
    layout: 'layouts/main'
  });
});

/**
 * @route   GET /identity/status
 * @desc    Acompanhamento do parecer de homologação cadastral
 */
router.get('/identity/status', authenticate, (req, res) => {
  return res.render('identity/verification-status', {
    title: 'Estado da Verificação — OneKixikila',
    layout: 'layouts/main'
  });
});

// -----------------------------------------------------------------------------
// 6. ÁREA ADMINISTRATIVA E GOVERNANÇA (Admin)
// -----------------------------------------------------------------------------

/**
 * @route   GET /admin
 * @desc    Painel executivo de monitorização e governança
 * @access  Privado (ADMIN, AUDITOR, FINANCIAL_OPERATOR, SUPPORT_AGENT)
 */
router.get(
  '/admin',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR', 'SUPPORT_AGENT'),
  (req, res) => {
    return res.render('admin/dashboard', {
      title: 'Painel Administrativo — OneKixikila',
      layout: 'layouts/admin'
    });
  }
);

/**
 * @route   GET /admin/users
 * @desc    Gestão de contas, atribuição de papéis e sanções disciplinares
 */
router.get(
  '/admin/users',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'SUPPORT_AGENT'),
  (req, res) => {
    return res.render('admin/users', {
      title: 'Gestão de Utilizadores — OneKixikila',
      layout: 'layouts/admin'
    });
  }
);

/**
 * @route   GET /admin/groups
 * @desc    Supervisão e auditoria de grupos de Kixikila
 */
router.get(
  '/admin/groups',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  (req, res) => {
    return res.render('admin/groups', {
      title: 'Supervisão de Grupos — OneKixikila',
      layout: 'layouts/admin'
    });
  }
);

/**
 * @route   GET /admin/identity-review
 * @desc    Fila de análise e homologação de documentos de identidade (KYC)
 */
router.get(
  '/admin/identity-review',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  (req, res) => {
    return res.render('admin/identity-review', {
      title: 'Revisão de Identidade — OneKixikila',
      layout: 'layouts/admin'
    });
  }
);

/**
 * @route   GET /admin/payments
 * @desc    Supervisão de pagamentos, liquidações e conciliação
 */
router.get(
  '/admin/payments',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR'),
  (req, res) => {
    return res.render('admin/payments', {
      title: 'Gestão de Pagamentos — OneKixikila',
      layout: 'layouts/admin'
    });
  }
);

/**
 * @route   GET /admin/disputes
 * @desc    Mediação e deliberação de contestações
 */
router.get(
  '/admin/disputes',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  (req, res) => {
    return res.render('admin/disputes', {
      title: 'Resolução de Disputas — OneKixikila',
      layout: 'layouts/admin'
    });
  }
);

/**
 * @route   GET /admin/reports
 * @desc    Relatórios analíticos, gráficos e métricas de desempenho
 */
router.get(
  '/admin/reports',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR'),
  (req, res) => {
    return res.render('admin/reports', {
      title: 'Relatórios Analíticos — OneKixikila',
      layout: 'layouts/admin'
    });
  }
);

/**
 * @route   GET /admin/audit
 * @desc    Consulta à trilha de eventos de auditoria institucional
 */
router.get(
  '/admin/audit',
  authenticate,
  authorize('ADMIN', 'AUDITOR'),
  (req, res) => {
    return res.render('admin/audit', {
      title: 'Auditoria Institucional — OneKixikila',
      layout: 'layouts/admin'
    });
  }
);

/**
 * @route   GET /admin/settings
 * @desc    Parâmetros operacionais da plataforma, limites e tarifas
 */
router.get(
  '/admin/settings',
  authenticate,
  authorize('ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR'),
  (req, res) => {
    return res.render('admin/settings', {
      title: 'Configurações do Sistema — OneKixikila',
      layout: 'layouts/admin'
    });
  }
);

module.exports = router;