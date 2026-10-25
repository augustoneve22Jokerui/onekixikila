const { pool, closePool } = require('../pool');
const { withTransaction } = require('../transaction');
const limitsConfig = require('../../config/limits');

/**
 * Povoa e sincroniza a matriz canónica de limites operacionais, políticas de taxas
 * e contas mestras do razão contábil. Seguro e idempotente para execução em qualquer ambiente.
 */
const runPermissionsSeed = async () => {
  console.log('\n[DATABASE:PERMISSIONS-SEED] Sincronizando limites, taxas e parâmetros de conformidade...');

  await withTransaction(async (client) => {
    // 1. Contas Institucionais do Livro-Razão (Double-entry core)
    console.log('[DATABASE:PERMISSIONS-SEED] Verificando contas mestras do plano de contas...');
    const systemAccounts = [
      { code: '1001-SETTLEMENT-POOL', name: 'Conta Transitória de Liquidação Interbancária', type: 'ASSET' },
      { code: '2001-USER-WALLETS', name: 'Passivo Exigível - Carteiras de Utilizadores', type: 'LIABILITY' },
      { code: '4001-PLATFORM-REVENUE', name: 'Receita Operacional de Taxas e Serviços', type: 'REVENUE' },
      { code: '5001-GATEWAY-EXPENSES', name: 'Custos e Tarifas de Gateways de Pagamento', type: 'EXPENSE' }
    ];

    for (const acc of systemAccounts) {
      await client.query(
        `INSERT INTO ledger_accounts (account_code, name, account_type, currency, is_system, balance)
         VALUES ($1, $2, $3, 'AOA', TRUE, 0)
         ON CONFLICT (account_code) DO NOTHING;`,
        [acc.code, acc.name, acc.type]
      );
    }

    // 2. Matriz Oficial de Limites Financeiros por Nível de Verificação (KYC Tiers)
    console.log('[DATABASE:PERMISSIONS-SEED] Sincronizando matriz de limites por nível de KYC...');
    const { tiers } = limitsConfig.financial;

    const limitsToSeed = [
      // TIER 1 - Não verificado (apenas contacto telefónico/email validado)
      { tier: 'TIER_1_UNVERIFIED', op: 'DEPOSIT', scope: 'PER_TRANSACTION', maxAmount: tiers.TIER_1_UNVERIFIED.maxSingleDeposit },
      { tier: 'TIER_1_UNVERIFIED', op: 'DEPOSIT', scope: 'DAILY', maxAmount: tiers.TIER_1_UNVERIFIED.maxDailyDeposit },
      { tier: 'TIER_1_UNVERIFIED', op: 'DEPOSIT', scope: 'MONTHLY', maxAmount: tiers.TIER_1_UNVERIFIED.maxMonthlyVolume },
      { tier: 'TIER_1_UNVERIFIED', op: 'INTERNAL_TRANSFER', scope: 'PER_TRANSACTION', maxAmount: tiers.TIER_1_UNVERIFIED.maxSingleTransfer },
      { tier: 'TIER_1_UNVERIFIED', op: 'INTERNAL_TRANSFER', scope: 'DAILY', maxAmount: tiers.TIER_1_UNVERIFIED.maxDailyTransfer },

      // TIER 2 - Verificado (Bilhete de Identidade e foto aprovados)
      { tier: 'TIER_2_VERIFIED', op: 'DEPOSIT', scope: 'PER_TRANSACTION', maxAmount: tiers.TIER_2_VERIFIED.maxSingleDeposit },
      { tier: 'TIER_2_VERIFIED', op: 'DEPOSIT', scope: 'DAILY', maxAmount: tiers.TIER_2_VERIFIED.maxDailyDeposit },
      { tier: 'TIER_2_VERIFIED', op: 'DEPOSIT', scope: 'MONTHLY', maxAmount: tiers.TIER_2_VERIFIED.maxMonthlyVolume },
      { tier: 'TIER_2_VERIFIED', op: 'INTERNAL_TRANSFER', scope: 'PER_TRANSACTION', maxAmount: tiers.TIER_2_VERIFIED.maxSingleTransfer },
      { tier: 'TIER_2_VERIFIED', op: 'INTERNAL_TRANSFER', scope: 'DAILY', maxAmount: tiers.TIER_2_VERIFIED.maxDailyTransfer },
      { tier: 'TIER_2_VERIFIED', op: 'WITHDRAWAL', scope: 'PER_TRANSACTION', maxAmount: tiers.TIER_2_VERIFIED.maxSingleWithdrawal },
      { tier: 'TIER_2_VERIFIED', op: 'WITHDRAWAL', scope: 'DAILY', maxAmount: tiers.TIER_2_VERIFIED.maxDailyWithdrawal },

      // TIER 3 - Reforçado (Histórico consolidado e diligência avançada)
      { tier: 'TIER_3_ENHANCED', op: 'DEPOSIT', scope: 'PER_TRANSACTION', maxAmount: tiers.TIER_3_ENHANCED.maxSingleDeposit },
      { tier: 'TIER_3_ENHANCED', op: 'DEPOSIT', scope: 'DAILY', maxAmount: tiers.TIER_3_ENHANCED.maxDailyDeposit },
      { tier: 'TIER_3_ENHANCED', op: 'DEPOSIT', scope: 'MONTHLY', maxAmount: tiers.TIER_3_ENHANCED.maxMonthlyVolume },
      { tier: 'TIER_3_ENHANCED', op: 'INTERNAL_TRANSFER', scope: 'PER_TRANSACTION', maxAmount: tiers.TIER_3_ENHANCED.maxSingleTransfer },
      { tier: 'TIER_3_ENHANCED', op: 'INTERNAL_TRANSFER', scope: 'DAILY', maxAmount: tiers.TIER_3_ENHANCED.maxDailyTransfer },
      { tier: 'TIER_3_ENHANCED', op: 'WITHDRAWAL', scope: 'PER_TRANSACTION', maxAmount: tiers.TIER_3_ENHANCED.maxSingleWithdrawal },
      { tier: 'TIER_3_ENHANCED', op: 'WITHDRAWAL', scope: 'DAILY', maxAmount: tiers.TIER_3_ENHANCED.maxDailyWithdrawal }
    ];

    for (const lim of limitsToSeed) {
      await client.query(
        `INSERT INTO limits (tier_code, operation_type, scope, max_amount, currency, is_active)
         VALUES ($1, $2, $3, $4, 'AOA', TRUE)
         ON CONFLICT (tier_code, operation_type, scope)
         DO UPDATE SET max_amount = EXCLUDED.max_amount, is_active = TRUE;`,
        [lim.tier, lim.op, lim.scope, lim.maxAmount]
      );
    }

    // 3. Tabela Canônica de Tarifas da Plataforma (Fees)
    console.log('[DATABASE:PERMISSIONS-SEED] Configurando taxas operacionais de serviço...');
    const defaultFees = [
      {
        code: 'FEE_DEPOSIT_MCX',
        name: 'Depósito via Multicaixa Express',
        op: 'DEPOSIT',
        calc: 'FLAT',
        flat: 0,
        bps: 0,
        min: 0,
        max: 0
      },
      {
        code: 'FEE_WITHDRAWAL_BANK',
        name: 'Levantamento para IBAN Bancário',
        op: 'WITHDRAWAL',
        calc: 'PERCENTAGE',
        flat: 100, // 100 Kz fixos
        bps: 100,  // 1.00%
        min: 100,
        max: 5000  // Máximo 5.000 Kz de comissão
      },
      {
        code: 'FEE_INTERNAL_TRANSFER',
        name: 'Transferência Interna entre Membros',
        op: 'INTERNAL_TRANSFER',
        calc: 'FLAT',
        flat: 0,
        bps: 0,
        min: 0,
        max: 0
      },
      {
        code: 'FEE_CONTRIBUTION_PAYMENT',
        name: 'Pagamento de Quota de Kixikila',
        op: 'CONTRIBUTION_PAYMENT',
        calc: 'FLAT',
        flat: 0,
        bps: 0,
        min: 0,
        max: 0
      }
    ];

    for (const fee of defaultFees) {
      await client.query(
        `INSERT INTO fees (
           fee_code, name, operation_type, calculation_type,
           flat_amount, basis_points, min_fee, max_fee, currency, is_active
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'AOA', TRUE)
         ON CONFLICT (fee_code)
         DO UPDATE SET
           name = EXCLUDED.name,
           flat_amount = EXCLUDED.flat_amount,
           basis_points = EXCLUDED.basis_points,
           max_fee = EXCLUDED.max_fee,
           is_active = TRUE;`,
        [fee.code, fee.name, fee.op, fee.calc, fee.flat, fee.bps, fee.min, fee.max]
      );
    }

    console.log('[DATABASE:PERMISSIONS-SEED] ✓ Sincronização concluída com sucesso!\n');
  });
};

if (require.main === module) {
  runPermissionsSeed()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[DATABASE:PERMISSIONS-SEED:FATAL]', err.message);
      await closePool();
      process.exit(1);
    });
}

module.exports = runPermissionsSeed;