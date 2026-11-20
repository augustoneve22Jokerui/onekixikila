const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const appConfig = require('./config/app');
const corsConfig = require('./config/cors');
const securityConfig = require('./config/security');
const securityHeaders = require('./middleware/security-headers');
const requestIdMiddleware = require('./middleware/request-id');
const requestTimeout = require('./middleware/request-timeout');
const requestLoggerMiddleware = require('./shared/logging/request-logger');
const auditContextMiddleware = require('./middleware/audit-context');
const csrfProtection = require('./middleware/csrf');
const notFoundHandler = require('./middleware/not-found');
const errorHandler = require('./middleware/error-handler');
const routes = require('./routes/index');

const app = express();

// Desativa o cabeçalho X-Powered-By (defesa em profundidade — Helmet também o faz)
app.disable('x-powered-by');

// -----------------------------------------------------------------------------
// CONFIGURAÇÃO DE PROXY E AMBIENTE
// -----------------------------------------------------------------------------

// Confia apenas no proxy reverso esperado em cada ambiente.
// Em produção (Render), há 1 proxy na frente da aplicação.
// Em desenvolvimento, NÃO confia em X-Forwarded-For (evita spoofing de IP).
app.set('trust proxy', appConfig.isProduction ? 1 : false);

// Configuração do motor de visualização server-side (EJS)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// -----------------------------------------------------------------------------
// PIPELINE DE SEGURANÇA E OBSERVABILIDADE HTTP
// -----------------------------------------------------------------------------
// A ORDEM é crítica:
//   1. securityHeaders — aplica CSP, HSTS, X-Frame-Options, etc. a TUDO.
//   2. cors — política de origens.
//   3. requestId — identifica a requisição para logging e tracing.
//   4. express.static — serve assets (DEPOIS de securityHeaders para terem CSP).
//   5. requestTimeout — limita a duração do pedido (lógica de negócio, não parse).
//   6. requestLogger — regista o acesso (depois do static para reduzir ruído).
//   7. auditContext — contexto de auditoria institucional.

app.use(securityHeaders);

app.use(cors(corsConfig));

app.use(requestIdMiddleware);

// Assets estáticos servidos DEPOIS de securityHeaders → herdam CSP, HSTS, etc.
// Servidos ANTES do requestLogger → não geram ruído no log de produção.
app.use(express.static(path.join(__dirname, 'public')));

const requestTimeoutMs =
  appConfig.server && Number.isFinite(appConfig.server.requestTimeoutMs)
    ? appConfig.server.requestTimeoutMs
    : 30000;

app.use(requestTimeout(requestTimeoutMs));

app.use(requestLoggerMiddleware);

app.use(auditContextMiddleware);

// -----------------------------------------------------------------------------
// PARSERS DE CORPO DE REQUISIÇÃO E COOKIES
// -----------------------------------------------------------------------------

// Parser JSON com preservação do buffer bruto (req.rawBody) para verificação
// de assinaturas HMAC de webhooks de pagamento.
app.use(
  express.json({
    limit: '10mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

// Parser de dados de formulários URL-encoded
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Parser de cookies.
// ⚠️ Os cookies de autenticação (onekixikila_token, onekixikila_refresh,
// _csrf_onekixikila) NÃO são assinados — são apenas httpOnly + secure + sameSite.
// Portanto NÃO passamos secret: não há benefício em assinar, e evita-se
// reutilizar o segredo JWT como segredo de cookie (separação de segredos).
// Se no futuro for necessário assinar cookies específicos, use um segredo
// DEDICADO (COOKIE_SECRET) e passe-o aqui.
app.use(cookieParser());

// -----------------------------------------------------------------------------
// PROTEÇÃO CSRF (GLOBAL)
// -----------------------------------------------------------------------------
// Aplicado globalmente para garantir que NENHUMA rota mutável escapa.
// O middleware csrf.js já trata as isenções:
//   - Webhooks de pagamento (/webhooks*)
//   - Rotas /api/* autenticadas via Bearer token
// Métodos GET, HEAD, OPTIONS são sempre isentos (SAFE_METHODS).
app.use(csrfProtection);

// -----------------------------------------------------------------------------
// ROTEAMENTO PRINCIPAL DA APLICAÇÃO
// -----------------------------------------------------------------------------

app.use(routes);

// -----------------------------------------------------------------------------
// TRATAMENTO DE ERROS E CAPTURA DE ROTAS NÃO ENCONTRADAS (404 / 500)
// -----------------------------------------------------------------------------

app.use(notFoundHandler);

app.use(errorHandler);

module.exports = app;