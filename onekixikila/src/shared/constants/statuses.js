/**
 * Catálogo canónico de estados do ciclo de vida das entidades da plataforma OneKixikila.
 * Sincronizado estritamente com os tipos enumerados do Neon PostgreSQL (Migrações 002 a 016).
 */

// Estados de Contas de Utilizador (`users.status`)
const USER_STATUSES = Object.freeze({
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  BLOCKED: 'BLOCKED',
  DEACTIVATED: 'DEACTIVATED'
});

// Estados de Processos de Verificação de Identidade KYC (`identity_verifications.status`)
const IDENTITY_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  UNDER_REVIEW: 'UNDER_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  EXPIRED: 'EXPIRED'
});

// Estados de Grupos de Kixikila (`groups.status`)
const GROUP_STATUSES = Object.freeze({
  DRAFT: 'DRAFT',
  FORMATION: 'FORMATION',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  SUSPENDED: 'SUSPENDED',
  CANCELLED: 'CANCELLED'
});

// Estados de Filiação de Membros (`group_memberships.status`)
const MEMBERSHIP_STATUSES = Object.freeze({
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  SUSPENDED: 'SUSPENDED',
  DEFAULTED: 'DEFAULTED',
  LEFT: 'LEFT',
  EXPELLED: 'EXPELLED'
});

// Estados de Convites de Adesão (`group_invitations.status`)
const INVITATION_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  DECLINED: 'DECLINED',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED'
});

// Estados das Rodadas de Calendário (`contribution_schedules.status`)
const SCHEDULE_STATUSES = Object.freeze({
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
});

// Estados de Obrigações Individuais de Quota (`contribution_obligations.status`)
const OBLIGATION_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  PAID: 'PAID',
  LATE: 'LATE',
  DEFAULTED: 'DEFAULTED',
  EXCUSED: 'EXCUSED'
});

// Estados de Liquidação de Quotas (`contributions.status`)
const CONTRIBUTION_STATUSES = Object.freeze({
  INITIATED: 'INITIATED',
  PROCESSING: 'PROCESSING',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED'
});

// Estados de Rotação do Bolo Financeiro (`rotation_schedules.status`)
const ROTATION_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  READY_FOR_PAYOUT: 'READY_FOR_PAYOUT',
  PAID_OUT: 'PAID_OUT',
  SKIPPED: 'SKIPPED',
  CANCELLED: 'CANCELLED'
});

// Estados da Carteira Interna (`wallets.status`)
const WALLET_STATUSES = Object.freeze({
  ACTIVE: 'ACTIVE',
  FROZEN: 'FROZEN',
  SUSPENDED: 'SUSPENDED',
  CLOSED: 'CLOSED'
});

// Estados de Depósito (`deposits.status`)
const DEPOSIT_STATUSES = Object.freeze({
  CREATED: 'CREATED',
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PROCESSING: 'PROCESSING',
  CONFIRMED: 'CONFIRMED',
  SETTLED: 'SETTLED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  RECONCILING: 'RECONCILING',
  IN_DISPUTE: 'IN_DISPUTE',
  REVERSED: 'REVERSED'
});

// Estados de Levantamento (`withdrawals.status`)
const WITHDRAWAL_STATUSES = Object.freeze({
  REQUESTED: 'REQUESTED',
  APPROVED: 'APPROVED',
  PROCESSING: 'PROCESSING',
  SETTLED: 'SETTLED',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  REVERSED: 'REVERSED'
});

// Estados de Transferências Internas (`internal_transfers.status`)
const TRANSFER_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  REVERSED: 'REVERSED'
});

// Estados de Pedidos de Pagamento (`payment_requests.status`)
const PAYMENT_REQUEST_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  REFUNDED: 'REFUNDED'
});

// Estados de Conciliação Contábil (`payment_reconciliations.status`)
const RECONCILIATION_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  MATCHED: 'MATCHED',
  DISCREPANCY_AMOUNT: 'DISCREPANCY_AMOUNT',
  DISCREPANCY_STATUS: 'DISCREPANCY_STATUS',
  MANUALLY_RESOLVED: 'MANUALLY_RESOLVED'
});

// Estados de Tokens QR (`qr_tokens.status`)
const QR_TOKEN_STATUSES = Object.freeze({
  ACTIVE: 'ACTIVE',
  USED: 'USED',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED'
});

// Estados de Disputas (`disputes.status`)
const DISPUTE_STATUSES = Object.freeze({
  OPEN: 'OPEN',
  UNDER_INVESTIGATION: 'UNDER_INVESTIGATION',
  RESOLVED_FAVOR_INITIATOR: 'RESOLVED_FAVOR_INITIATOR',
  RESOLVED_FAVOR_RESPONDENT: 'RESOLVED_FAVOR_RESPONDENT',
  CLOSED_DISMISSED: 'CLOSED_DISMISSED'
});

// Estados de Notificações (`notifications.status`)
const NOTIFICATION_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
  READ: 'READ'
});

// Estados de Idempotência (`idempotency_keys.status`)
const IDEMPOTENCY_STATUSES = Object.freeze({
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
});

// Helpers de Avaliação de Estados Terminais
const isTerminalPaymentStatus = (status) => {
  return ['SUCCEEDED', 'SETTLED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED'].includes(status);
};

const isWalletOperable = (status) => {
  return status === WALLET_STATUSES.ACTIVE;
};

module.exports = {
  USER_STATUSES,
  IDENTITY_STATUSES,
  GROUP_STATUSES,
  MEMBERSHIP_STATUSES,
  INVITATION_STATUSES,
  SCHEDULE_STATUSES,
  OBLIGATION_STATUSES,
  CONTRIBUTION_STATUSES,
  ROTATION_STATUSES,
  WALLET_STATUSES,
  DEPOSIT_STATUSES,
  WITHDRAWAL_STATUSES,
  TRANSFER_STATUSES,
  PAYMENT_REQUEST_STATUSES,
  RECONCILIATION_STATUSES,
  QR_TOKEN_STATUSES,
  DISPUTE_STATUSES,
  NOTIFICATION_STATUSES,
  IDEMPOTENCY_STATUSES,
  isTerminalPaymentStatus,
  isWalletOperable
};