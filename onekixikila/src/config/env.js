const path = require('path');
const dotenv = require('dotenv');
const { z } = require('zod');

// Carrega o ficheiro .env a partir da raiz do projeto
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const envSchema = z.object({
  // Ambiente e Servidor
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  APP_NAME: z.string().default('OneKixikila'),
  DEFAULT_CURRENCY: z.string().length(3).default('AOA'),

  // Base de Dados Neon PostgreSQL
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatória para a persistência.'),
  DATABASE_SSL: z
    .string()
    .transform((val) => val === 'true' || val === '1')
    .default('true'),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().positive().default(20),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  // Chaves de Sessão, JWT e Criptografia
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET deve conter pelo menos 32 caracteres.'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET deve conter pelo menos 32 caracteres.'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_SECRET: z.string().min(32, 'REFRESH_TOKEN_SECRET deve conter pelo menos 32 caracteres.'),
  REFRESH_TOKEN_EXPIRES_IN: z.string().default('7d'),
  DATA_ENCRYPTION_KEY: z.string().min(32, 'DATA_ENCRYPTION_KEY deve conter chave de segurança de 32 bytes.'),

  // CORS e Rate Limiting
  CORS_ALLOWED_ORIGINS: z.string().default('http://localhost:3000,https://onekixikila.onrender.com'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
  AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(5),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),

  // Armazenamento Neon Object Storage (compatível com S3)
  STORAGE_ENDPOINT: z.string().url().optional().or(z.literal('')),
  STORAGE_REGION: z.string().default('eu-central-1'),
  STORAGE_ACCESS_KEY_ID: z.string().optional().or(z.literal('')),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional().or(z.literal('')),
  STORAGE_BUCKET_UPLOADS: z.string().default('upload'),
  STORAGE_BUCKET_ASSETS: z.string().default('assets'),
  STORAGE_BUCKET_DOCUMENTS: z.string().default('documentos'),

  // Limites estritos de envio (Bytes)
  MAX_DOCUMENT_SIZE_BYTES: z.coerce.number().int().positive().default(5242880), // 5 MB exatos
  MAX_AUDIO_SIZE_BYTES: z.coerce.number().int().positive().default(10485760),   // 10 MB
  MAX_IMAGE_SIZE_BYTES: z.coerce.number().int().positive().default(5242880),   // 5 MB

  // Provedores de Pagamento (configurações operacionais)
  MULTICAIXA_EXPRESS_API_URL: z.string().optional().or(z.literal('')),
  MULTICAIXA_EXPRESS_CLIENT_ID: z.string().optional().or(z.literal('')),
  MULTICAIXA_EXPRESS_CLIENT_SECRET: z.string().optional().or(z.literal('')),
  MULTICAIXA_EXPRESS_WEBHOOK_SECRET: z.string().optional().or(z.literal('')),

  UNITEL_MONEY_API_URL: z.string().optional().or(z.literal('')),
  UNITEL_MONEY_CLIENT_ID: z.string().optional().or(z.literal('')),
  UNITEL_MONEY_CLIENT_SECRET: z.string().optional().or(z.literal('')),
  UNITEL_MONEY_WEBHOOK_SECRET: z.string().optional().or(z.literal('')),

  E_KWANZA_API_URL: z.string().optional().or(z.literal('')),
  E_KWANZA_API_KEY: z.string().optional().or(z.literal('')),
  E_KWANZA_WEBHOOK_SECRET: z.string().optional().or(z.literal('')),

  // Notificações (SMTP / SMS)
  SMTP_HOST: z.string().optional().or(z.literal('')),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional().or(z.literal('')),
  SMTP_PASS: z.string().optional().or(z.literal('')),
  SMTP_FROM: z.string().default('nao-responder@onekixikila.ao'),

  SMS_GATEWAY_URL: z.string().optional().or(z.literal('')),
  SMS_API_KEY: z.string().optional().or(z.literal('')),
  SMS_SENDER_ID: z.string().default('OneKixikila')
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const formattedErrors = parsedEnv.error.errors
    .map((err) => `  - [${err.path.join('.')}]: ${err.message}`)
    .join('\n');

  console.error('\n======================================================');
  console.error('ERRO FATAL NA VALIDAÇÃO DAS VARIÁVEIS DE AMBIENTE:');
  console.error(formattedErrors);
  console.error('======================================================\n');

  throw new Error('Falha na inicialização: Variáveis de ambiente inválidas ou ausentes.');
}

const env = Object.freeze(parsedEnv.data);

module.exports = env;