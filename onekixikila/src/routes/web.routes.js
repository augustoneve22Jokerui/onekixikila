// =============================================================================
// routes/web.routes.js
// =============================================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const { authenticate, authenticateOptional } = require('../middleware/authenticate');
const { authorize, requireGroupMembership } = require('../middleware/authorize');
const csrfProtection = require('../middleware/csrf');
const appConfig = require('../config/app');
const groupsRepository = require('../modules/groups/groups.repository');
const membershipsRepository = require('../modules/memberships/memberships.repository');
const { chatPolicy } = require('../modules/chat/chat.policy');

const router = express.Router();

// Papéis administrativos que acedem ao painel /admin por padrão
const ADMINISTRATIVE_ROLES = new Set(['ADMIN', 'AUDITOR', 'FINANCIAL_OPERATOR', 'SUPPORT_AGENT']);

/**
 * Determina o destino padrão de redirecionamento com base no papel do utilizador.
 * @param {object|null} user
 * @returns {string}
 */
const resolveHomePath = (user) => {
  if (!user) return '/login';
  return ADMINISTRATIVE_ROLES.has(user.role) ? '/admin' : '/dashboard';
};

// -----------------------------------------------------------------------------
// 0. ASSETS PÚBLICOS E TRATAMENTO DE FAVICON (Antes do CSRF)
// -----------------------------------------------------------------------------

/**
 * @route   GET /favicon.ico e /assets/images/favicon.ico
 * @desc    Evita registos de erro 404 no console caso o favicon ainda não esteja presente
 */
router.get(['/favicon.ico', '/assets/images/favicon.ico'], (req, res) => {
  res.status(204).end();
});

/**
 * @route   GET /assets/images/avatar-default.png
 * @desc    Serve o avatar padrão ou retorna um SVG inline equivalente se o PNG não existir
 */
router.get('/assets/images/avatar-default.png', (req, res) => {
  const pngPath = path.join(__dirname, '..', 'public', 'assets', 'images', 'avatar-default.png');

  if (fs.existsSync(pngPath)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(pngPath);
  }

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
      <circle cx="64" cy="64" r="64" fill="#7c3aed"/>
      <circle cx="64" cy="48" r="24" fill="#ffffff" opacity="0.9"/>
      <path d="M20 114c0-24.3 19.7-44 44-44s44 19.7 44 44" fill="#ffffff" opacity="0.9"/>
    </svg>
  `.trim();

  const buffer = Buffer.from(svg, 'utf8');
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.status(200).send(buffer);
});

// Aplica proteção CSRF a todas as rotas web
router.use(csrfProtection);

// -----------------------------------------------------------------------------
// AUTENTICAÇÃO GLOBAL OPCIONAL
// -----------------------------------------------------------------------------
// Corre UMA vez para todas as rotas, garantindo que `req.user` (ou null) e
// `req.auth` (ou null) estão sempre disponíveis antes de qualquer handler.
router.use(authenticateOptional);

// Middleware para disponibilizar metadados globais da aplicação às views EJS.
// Corre APÓS `authenticateOptional`, pelo que `req.user` já está resolvido.
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
 * @desc    Página inicial: redireciona utilizadores com sessão ativa para o seu painel respetivo
 */
router.get('/', (req, res) => {
  if (req.user) {
    return res.redirect(resolveHomePath(req.user));
  }
  return res.render('auth/login', {
    title: 'Iniciar Sessão — OneKixikila',
    layout: 'layouts/auth'
  });
});

/**
 * @route   GET /login
 * @desc    Formulário de início de sessão (com redirecionamento inteligente se já autenticado)
 */
router.get('/login', (req, res) => {
  if (req.user) {
    return res.redirect(resolveHomePath(req.user));
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
router.get('/register', (req, res) => {
  if (req.user) {
    return res.redirect(resolveHomePath(req.user));
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
router.get('/verify-account', (req, res) => {
  const identifier = req.query.identifier || '';
  const type = req.query.type || 'PHONE';

  if (!identifier && !req.user) {
    return res.redirect('/register');
  }

  return res.render('auth/verify-account', {
    title: 'Verificar Conta — OneKixikila',
    layout: 'layouts/auth',
    type,
    identifier
  });
});

/**
 * @route   GET /forgot-password
 * @desc    Página para solicitação de recuperação de credenciais
 */
router.get('/forgot-password', (req, res) => {
  return res.render('auth/forgot-password', {
    title: 'Recuperar Palavra-passe — OneKixikila',
    layout: 'layouts/auth'
  });
});

/**
 * @route   GET /reset-password
 * @desc    Formulário para redefinição de palavra-passe com token
 */
router.get('/reset-password', (req, res) => {
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
// 2. PAINEL DO UTILIZADOR / MEMBRO (Dashboard Pessoal)
// -----------------------------------------------------------------------------

/**
 * @route   GET /dashboard
 * @desc    Painel pessoal com visão geral de grupos, saldo e quotas
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
 * @desc    Exploração de grupos públicos e lista de grupos em que participa
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
 * @route   GET /groups/join
 * @desc    Página pública de pré-visualização do convite (?code=... ou ?qr=...)
 * @access  Público (opcionalmente autenticado)
 */
router.get('/groups/join', (req, res) => {
  const code = req.query.code || req.query.inviteCode || req.query.invite_code || '';
  const qrTokenCode = req.query.qr || req.query.qrTokenCode || '';

  if (!code && !qrTokenCode) {
    return res.redirect('/groups');
  }

  return res.render('groups/join', {
    title: 'Entrar no Grupo — OneKixikila',
    layout: req.user ? 'layouts/main' : 'layouts/auth',
    inviteCode: code,
    qrTokenCode
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
 *
 * A página do chat é privada: só membros ativos e os papéis autorizados pela
 * política de chat podem carregá-la. A validação da API e do WebSocket mantém-se
 * necessária e independente deste controlo da página.
 *
 * Pipeline de segurança:
 *   1. `authenticate` — exige sessão ativa.
 *   2. `requireGroupMembership({ requireActiveStatus: true })` — valida que
 *      `req.user` é membro ATIVO do grupo indicado em `:groupId` (por UUID
 *      ou por slug, conforme implementação do middleware).
 *   3. `chatPolicy.canAccessChat` — validação adicional por papel/política
 *      dentro do handler, garantindo que apenas papéis autorizados (ex.:
 *      SUPPORT_AGENT em modo de auditoria) acedem.
 */
router.get(
  '/groups/:groupId/chat',
  authenticate,
  requireGroupMembership({ requireActiveStatus: true }),
  async (req, res, next) => {
    try {
      const requestedGroupId = req.params.groupId;
      const group =
        (await groupsRepository.findById(requestedGroupId)) ||
        (await groupsRepository.findBySlug(requestedGroupId));

      if (!group) {
        return res.status(404).render('errors/404', {
          title: 'Grupo não encontrado — OneKixikila',
          layout: 'layouts/main'
        });
      }

      const membership = await membershipsRepository.findByGroupAndUser(group.id, req.user.id);
      const accessCheck = chatPolicy.canAccessChat(req.user, group, membership);

      if (!accessCheck.allowed) {
        return res.status(403).render('errors/403', {
          title: 'Acesso negado — OneKixikila',
          layout: 'layouts/main'
        });
      }

      return res.render('groups/chat', {
        title: 'Chat do Grupo — OneKixikila',
        layout: 'layouts/main',
        groupId: group.id
      });
    } catch (error) {
      return next(error);
    }
  }
);

// -----------------------------------------------------------------------------
// 4. CARTEIRA DIGITAL E FINANÇAS
// -----------------------------------------------------------------------------

/**
 * @route   GET /wallet
 * @desc    Painel da carteira com saldos e opções de movimentação
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