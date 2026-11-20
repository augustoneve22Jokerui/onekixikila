const { USER_ROLES } = require('./roles');

/**
 * Catálogo granular de permissões da plataforma OneKixikila.
 * Permite controlo de acesso baseado em capacidades (Capability-Based Access Control).
 */
const PERMISSIONS = Object.freeze({
  // Gestão de Utilizadores e Contas
  USERS_READ_SELF: 'users:read:self',
  USERS_UPDATE_SELF: 'users:update:self',
  USERS_READ_ANY: 'users:read:any',
  USERS_MANAGE_STATUS: 'users:manage:status',

  // Conformidade e Identidade (KYC)
  KYC_SUBMIT: 'kyc:submit',
  KYC_VIEW_OWN: 'kyc:view:own',
  KYC_REVIEW_DOCUMENTS: 'kyc:review:documents',
  KYC_VIEW_SENSITIVE: 'kyc:view:sensitive',

  // Grupos de Kixikila
  GROUPS_CREATE: 'groups:create',
  GROUPS_VIEW_PUBLIC: 'groups:view:public',
  GROUPS_JOIN_REQUEST: 'groups:join:request',
  GROUPS_MANAGE_OWN: 'groups:manage:own',
  GROUPS_SUPERVISE_ANY: 'groups:supervise:any',

  // Liderança e Membros
  MEMBERS_APPROVE: 'members:approve',
  MEMBERS_REMOVE: 'members:remove',
  MEMBERS_RESTRICT: 'members:restrict',
  LEADERSHIP_DELEGATE: 'leadership:delegate',

  // Carteira e Finanças Pessoais
  WALLET_READ_SELF: 'wallet:read:self',
  WALLET_DEPOSIT: 'wallet:deposit',
  WALLET_TRANSFER: 'wallet:transfer',
  WALLET_WITHDRAW: 'wallet:withdraw',

  // Contribuições e Rotações da Kixikila
  CONTRIBUTIONS_PAY: 'contributions:pay',
  ROTATION_RECEIVE_PAYOUT: 'rotation:receive:payout',
  ROTATION_SWAP_REQUEST: 'rotation:swap:request',
  ROTATION_SWAP_APPROVE: 'rotation:swap:approve',

  // Livro-Razão, Tesouraria e Conciliação
  LEDGER_VIEW_OWN: 'ledger:view:own',
  LEDGER_AUDIT_SYSTEM: 'ledger:audit:system',
  RECONCILIATION_RUN: 'reconciliation:run',
  RECONCILIATION_RESOLVE: 'reconciliation:resolve',
  FEES_MANAGE: 'fees:manage',

  // Disputas e Risco
  DISPUTES_OPEN: 'disputes:open',
  DISPUTES_INVESTIGATE: 'disputes:investigate',
  DISPUTES_RESOLVE: 'disputes:resolve',
  RISK_VIEW_EVENTS: 'risk:view:events',

  // Comunicação e Chat
  CHAT_READ: 'chat:read',
  CHAT_SEND_TEXT: 'chat:send:text',
  CHAT_SEND_AUDIO: 'chat:send:audio',
  CHAT_SEND_DOCUMENT: 'chat:send:document',
  CHAT_MODERATE: 'chat:moderate',

  // Auditoria e Administração Global
  AUDIT_LOGS_VIEW: 'audit:logs:view',
  SYSTEM_SETTINGS_MANAGE: 'system:settings:manage'
});

// Matriz de permissões atribuídas a cada papel global da plataforma
const ROLE_PERMISSIONS = Object.freeze({
  [USER_ROLES.USER]: Object.freeze([
    PERMISSIONS.USERS_READ_SELF,
    PERMISSIONS.USERS_UPDATE_SELF,
    PERMISSIONS.KYC_SUBMIT,
    PERMISSIONS.KYC_VIEW_OWN,
    PERMISSIONS.GROUPS_VIEW_PUBLIC,
    PERMISSIONS.GROUPS_JOIN_REQUEST,
    PERMISSIONS.WALLET_READ_SELF,
    PERMISSIONS.WALLET_DEPOSIT
  ]),

  [USER_ROLES.MEMBER]: Object.freeze([
    PERMISSIONS.USERS_READ_SELF,
    PERMISSIONS.USERS_UPDATE_SELF,
    PERMISSIONS.KYC_SUBMIT,
    PERMISSIONS.KYC_VIEW_OWN,
    PERMISSIONS.GROUPS_CREATE,
    PERMISSIONS.GROUPS_VIEW_PUBLIC,
    PERMISSIONS.GROUPS_JOIN_REQUEST,
    PERMISSIONS.WALLET_READ_SELF,
    PERMISSIONS.WALLET_DEPOSIT,
    PERMISSIONS.WALLET_TRANSFER,
    PERMISSIONS.WALLET_WITHDRAW,
    PERMISSIONS.CONTRIBUTIONS_PAY,
    PERMISSIONS.ROTATION_RECEIVE_PAYOUT,
    PERMISSIONS.ROTATION_SWAP_REQUEST,
    PERMISSIONS.LEDGER_VIEW_OWN,
    PERMISSIONS.DISPUTES_OPEN,
    PERMISSIONS.CHAT_READ,
    PERMISSIONS.CHAT_SEND_TEXT,
    PERMISSIONS.CHAT_SEND_AUDIO,
    PERMISSIONS.CHAT_SEND_DOCUMENT
  ]),

  [USER_ROLES.GROUP_LEADER]: Object.freeze([
    PERMISSIONS.USERS_READ_SELF,
    PERMISSIONS.USERS_UPDATE_SELF,
    PERMISSIONS.KYC_SUBMIT,
    PERMISSIONS.KYC_VIEW_OWN,
    PERMISSIONS.GROUPS_CREATE,
    PERMISSIONS.GROUPS_VIEW_PUBLIC,
    PERMISSIONS.GROUPS_JOIN_REQUEST,
    PERMISSIONS.GROUPS_MANAGE_OWN,
    PERMISSIONS.MEMBERS_APPROVE,
    PERMISSIONS.MEMBERS_REMOVE,
    PERMISSIONS.MEMBERS_RESTRICT,
    PERMISSIONS.LEADERSHIP_DELEGATE,
    PERMISSIONS.WALLET_READ_SELF,
    PERMISSIONS.WALLET_DEPOSIT,
    PERMISSIONS.WALLET_TRANSFER,
    PERMISSIONS.WALLET_WITHDRAW,
    PERMISSIONS.CONTRIBUTIONS_PAY,
    PERMISSIONS.ROTATION_RECEIVE_PAYOUT,
    PERMISSIONS.ROTATION_SWAP_REQUEST,
    PERMISSIONS.ROTATION_SWAP_APPROVE,
    PERMISSIONS.LEDGER_VIEW_OWN,
    PERMISSIONS.DISPUTES_OPEN,
    PERMISSIONS.CHAT_READ,
    PERMISSIONS.CHAT_SEND_TEXT,
    PERMISSIONS.CHAT_SEND_AUDIO,
    PERMISSIONS.CHAT_SEND_DOCUMENT,
    PERMISSIONS.CHAT_MODERATE
  ]),

  [USER_ROLES.MODERATOR]: Object.freeze([
    PERMISSIONS.USERS_READ_SELF,
    PERMISSIONS.USERS_UPDATE_SELF,
    PERMISSIONS.GROUPS_VIEW_PUBLIC,
    PERMISSIONS.CHAT_READ,
    PERMISSIONS.CHAT_MODERATE,
    PERMISSIONS.DISPUTES_INVESTIGATE
  ]),

  [USER_ROLES.SUPPORT_AGENT]: Object.freeze([
    PERMISSIONS.USERS_READ_SELF,
    PERMISSIONS.USERS_UPDATE_SELF,
    PERMISSIONS.USERS_READ_ANY,
    PERMISSIONS.KYC_VIEW_OWN,
    PERMISSIONS.GROUPS_VIEW_PUBLIC,
    PERMISSIONS.DISPUTES_INVESTIGATE,
    PERMISSIONS.CHAT_READ
  ]),

  [USER_ROLES.FINANCIAL_OPERATOR]: Object.freeze([
    PERMISSIONS.USERS_READ_SELF,
    PERMISSIONS.WALLET_READ_SELF,
    PERMISSIONS.LEDGER_AUDIT_SYSTEM,
    PERMISSIONS.RECONCILIATION_RUN,
    PERMISSIONS.FEES_MANAGE
  ]),

  [USER_ROLES.AUDITOR]: Object.freeze([
    PERMISSIONS.USERS_READ_SELF,
    PERMISSIONS.USERS_READ_ANY,
    PERMISSIONS.KYC_VIEW_SENSITIVE,
    PERMISSIONS.LEDGER_AUDIT_SYSTEM,
    PERMISSIONS.RECONCILIATION_RUN,
    PERMISSIONS.RECONCILIATION_RESOLVE,
    PERMISSIONS.DISPUTES_INVESTIGATE,
    PERMISSIONS.DISPUTES_RESOLVE,
    PERMISSIONS.RISK_VIEW_EVENTS,
    PERMISSIONS.AUDIT_LOGS_VIEW
  ]),

  [USER_ROLES.ADMIN]: Object.freeze(Object.values(PERMISSIONS))
});

/**
 * Avalia se determinado papel de utilizador detém uma permissão específica.
 * @param {string} role
 * @param {string} permission
 * @returns {boolean}
 */
const hasPermission = (role, permission) => {
  const allowed = ROLE_PERMISSIONS[role];
  return Boolean(allowed && allowed.includes(permission));
};

module.exports = {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  hasPermission
};