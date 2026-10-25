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
const notFoundHandler = require('./middleware/not-found');
const errorHandler = require('./middleware/error-handler');
const routes = require('./routes/index');

const app = express();

// Configuração de confiança no proxy reverso do Render (para captura correta de IP real e protocolo HTTPS)
app.set('trust proxy', 1);

// Configuração do motor de visualização server-side (EJS)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Servir recursos estáticos públicos da plataforma (CSS, JS, imagens, ícones)
app.use(express.static(path.join(__dirname, 'public')));

// -----------------------------------------------------------------------------
// PIPELINE DE SEGURANÇA E OBSERVABILIDADE HTTP
// -----------------------------------------------------------------------------

// Aplicação de cabeçalhos de proteção avançada (Helmet, CSP, HSTS, Permissions-Policy)
app.use(securityHeaders);

// Política de Cross-Origin Resource Sharing (CORS) com origens autorizadas
app.use(cors(corsConfig));

// Injeção e propagação do identificador único de rastreamento (X-Request-ID)
app.use(requestIdMiddleware);

// Gestão de tempo limite por requisição (prevenção de esgotamento de conexões)
app.use(requestTimeout(appConfig.server.requestTimeoutMs));

// Registo estruturado de acessos e medição de latência com expurgo de dados sensíveis
app.use(requestLoggerMiddleware);

// Injeção de contexto de auditoria institucional (req.auditContext e req.recordAudit)
app.use(auditContextMiddleware);

// -----------------------------------------------------------------------------
// PARSERS DE CORPO DE REQUISIÇÃO E COOKIES
// -----------------------------------------------------------------------------

// Parser JSON com preservação do buffer bruto (req.rawBody) para verificação de assinaturas HMAC de webhooks
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

// Parser de cookies com assinatura criptográfica
app.use(cookieParser(securityConfig.jwt.accessTokenSecret || appConfig.session.secret));

// -----------------------------------------------------------------------------
// ROTEAMENTO PRINCIPAL DA APLICAÇÃO
// -----------------------------------------------------------------------------

app.use(routes);

// -----------------------------------------------------------------------------
// TRATAMENTO DE ERROS E CAPTURA DE ROTAS NÃO ENCONTRADAS (404 / 500)
// -----------------------------------------------------------------------------

// Captura requisições sem correspondência de rota (HTTP 404)
app.use(notFoundHandler);

// Tratamento centralizado e seguro de exceções (HTTP 500 / 4xx)
app.use(errorHandler);

module.exports = app;