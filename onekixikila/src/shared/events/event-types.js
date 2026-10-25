/**
 * Catálogo canónico de tipos de eventos de domínio da plataforma OneKixikila.
 * Define a nomenclatura padronizada para a comunicação assíncrona entre o barramento
 * de eventos (EventBus), serviços de mensageria, tarefas de auditoria e despachos de notificações.
 */
const EVENT_TYPES = Object.freeze({
  // --------------------------------------------------------------------------
  // 1. Autenticação, Contas e Segurança
  // --------------------------------------------------------------------------
  AUTH_USER_REGISTERED: 'auth:user:registered',
  AUTH_EMAIL_VERIFIED: 'auth:email:verified',
  AUTH_PHONE_VERIFIED: 'auth:phone:verified',
  AUTH_PASSWORD_RESET_REQUESTED: 'auth:password:reset_requested',
  AUTH_PASSWORD_CHANGED: 'auth:password:changed',
  AUTH_LOGIN_SUCCESS: 'auth:login:success',
  AUTH_LOGIN_FAILED: 'auth:login:failed',
  AUTH_SESSION_REVOKED: 'auth:session:revoked',
  AUTH_DEVICE_LINKED: 'auth:device:linked',

  // --------------------------------------------------------------------------
  // 2. Identidade e Verificação KYC
  // --------------------------------------------------------------------------
  IDENTITY_SUBMITTED: 'identity:verification:submitted',
  IDENTITY_APPROVED: 'identity:verification:approved',
  IDENTITY_REJECTED: 'identity:verification:rejected',
  IDENTITY_NEEDS_REVIEW: 'identity:verification:needs_review',

  // --------------------------------------------------------------------------
  // 3. Grupos de Kixikila, Filiação e Liderança
  // --------------------------------------------------------------------------
  GROUP_CREATED: 'group:created',
  GROUP_ACTIVATED: 'group:activated',
  GROUP_PAUSED: 'group:paused',
  GROUP_COMPLETED: 'group:completed',
  GROUP_RULES_UPDATED: 'group:rules:updated',
  GROUP_INVITATION_SENT: 'group:invitation:sent',
  GROUP_INVITATION_ACCEPTED: 'group:invitation:accepted',
  GROUP_MEMBERSHIP_REQUESTED: 'group:membership:requested',
  GROUP_MEMBERSHIP_APPROVED: 'group:membership:approved',
  GROUP_MEMBERSHIP_SUSPENDED: 'group:membership:suspended',
  GROUP_MEMBERSHIP_LEFT: 'group:membership:left',
  GROUP_LEADERSHIP_DELEGATED: 'group:leadership:delegated',
  GROUP_LEADERSHIP_TRANSFERRED: 'group:leadership:transferred',

  // --------------------------------------------------------------------------
  // 4. Calendário, Quotas de Contribuição e Rotações
  // --------------------------------------------------------------------------
  CONTRIBUTION_DUE_REMINDER: 'contribution:due:reminder',
  CONTRIBUTION_MARKED_LATE: 'contribution:marked:late',
  CONTRIBUTION_DEFAULTED: 'contribution:defaulted',
  CONTRIBUTION_PAID: 'contribution:paid',
  ROTATION_ROUND_COMPLETED: 'rotation:round:completed',
  ROTATION_PAYOUT_TRIGGERED: 'rotation:payout:triggered',
  ROTATION_PAYOUT_SETTLED: 'rotation:payout:settled',
  ROTATION_SWAP_REQUESTED: 'rotation:swap:requested',
  ROTATION_SWAP_APPROVED: 'rotation:swap:approved',

  // --------------------------------------------------------------------------
  // 5. Carteiras Internas e Operações de Tesouraria
  // --------------------------------------------------------------------------
  WALLET_FROZEN: 'wallet:frozen',
  WALLET_UNFROZEN: 'wallet:unfrozen',
  DEPOSIT_INITIATED: 'wallet:deposit:initiated',
  DEPOSIT_CONFIRMED: 'wallet:deposit:confirmed',
  DEPOSIT_FAILED: 'wallet:deposit:failed',
  WITHDRAWAL_REQUESTED: 'wallet:withdrawal:requested',
  WITHDRAWAL_APPROVED: 'wallet:withdrawal:approved',
  WITHDRAWAL_SETTLED: 'wallet:withdrawal:settled',
  WITHDRAWAL_REJECTED: 'wallet:withdrawal:rejected',
  TRANSFER_INTERNAL_COMPLETED: 'wallet:transfer:completed',

  // --------------------------------------------------------------------------
  // 6. Prestadores de Pagamento e Reconciliação
  // --------------------------------------------------------------------------
  PAYMENT_REQUEST_CREATED: 'payment:request:created',
  PAYMENT_WEBHOOK_RECEIVED: 'payment:webhook:received',
  PAYMENT_RECONCILIATION_COMPLETED: 'payment:reconciliation:completed',
  PAYMENT_DISCREPANCY_DETECTED: 'payment:discrepancy:detected',

  // --------------------------------------------------------------------------
  // 7. Comunicação e Chat de Grupo
  // --------------------------------------------------------------------------
  CHAT_TEXT_MESSAGE_SENT: 'chat:message:text_sent',
  CHAT_AUDIO_MESSAGE_SENT: 'chat:message:audio_sent',
  CHAT_DOCUMENT_SENT: 'chat:message:document_sent',
  CHAT_MESSAGE_DELETED: 'chat:message:deleted',
  CHAT_MESSAGE_REPORTED: 'chat:message:reported',

  // --------------------------------------------------------------------------
  // 8. Disputas e Risco
  // --------------------------------------------------------------------------
  DISPUTE_OPENED: 'dispute:opened',
  DISPUTE_RESOLVED: 'dispute:resolved',
  RISK_ALERT_TRIGGERED: 'risk:alert:triggered'
});

const ALL_EVENT_TYPES = Object.freeze(new Set(Object.values(EVENT_TYPES)));

/**
 * Valida se determinada cadeia representa um tipo de evento canónico registado.
 *
 * @param {string} type
 * @returns {boolean}
 */
const isValidEventType = (type) => {
  return typeof type === 'string' && ALL_EVENT_TYPES.has(type);
};

module.exports = {
  EVENT_TYPES,
  ALL_EVENT_TYPES,
  isValidEventType
};