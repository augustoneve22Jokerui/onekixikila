const argon2 = require('argon2');
const { pool, closePool } = require('../pool');
const { withTransaction } = require('../transaction');
const appConfig = require('../../config/app');
const securityConfig = require('../../config/security');
const limitsConfig = require('../../config/limits');

/**
 * Script de povoamento inicial de dados para desenvolvimento e homologação.
 * Bloqueado expressamente em ambiente de produção para garantir integridade.
 */
const runDevelopmentSeed = async () => {
  if (appConfig.isProduction) {
    console.error('[DATABASE:SEED:BLOCKED] Execução de seeds de desenvolvimento não permitida em ambiente de produção.');
    process.exit(1);
  }

  console.log('\n[DATABASE:SEED] Iniciando povoamento de dados de desenvolvimento no Neon PostgreSQL...');

  await withTransaction(async (client) => {
    // 1. Gera hashes de palavra-passe com parâmetros oficiais do Argon2id
    const defaultPassword = 'OneKixikila2026!Segura';
    const passwordHash = await argon2.hash(defaultPassword, securityConfig.argon2);

    // 2. Criação de Contas do Sistema no Livro-Razão (Plano de Contas)
    console.log('[DATABASE:SEED] Criando contas mestras do plano de contas contábil...');
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

    // 3. Criação de Utilizadores de Demonstração
    console.log('[DATABASE:SEED] Criando utilizadores e carteiras de teste...');
    const seedUsers = [
      {
        email: 'admin@onekixikila.ao',
        phone: '+244923000001',
        role: 'ADMIN',
        fullName: 'Administrador Geral OneKixikila',
        province: 'Luanda',
        municipality: 'Talatona'
      },
      {
        email: 'lider.kixikila@onekixikila.ao',
        phone: '+244923000002',
        role: 'GROUP_LEADER',
        fullName: 'Manuel Domingos Kiala',
        province: 'Luanda',
        municipality: 'Ingombota'
      },
      {
        email: 'membro1@onekixikila.ao',
        phone: '+244923000003',
        role: 'MEMBER',
        fullName: 'Esperança Neves dos Santos',
        province: 'Luanda',
        municipality: 'Belas'
      },
      {
        email: 'membro2@onekixikila.ao',
        phone: '+244923000004',
        role: 'MEMBER',
        fullName: 'António João Baptista',
        province: 'Luanda',
        municipality: 'Viana'
      }
    ];

    const createdUsers = [];

    for (const u of seedUsers) {
      // Inserção do utilizador
      const userRes = await client.query(
        `INSERT INTO users (
           email, phone_number, password_hash, role, status,
           is_email_verified, is_phone_verified, email_verified_at, phone_verified_at
         )
         VALUES ($1, $2, $3, $4, 'ACTIVE', TRUE, TRUE, NOW() AT TIME ZONE 'UTC', NOW() AT TIME ZONE 'UTC')
         ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role
         RETURNING id, email, role;`,
        [u.email, u.phone, passwordHash, u.role]
      );

      const userId = userRes.rows[0].id;
      createdUsers.push({ id: userId, ...u });

      // Inserção do perfil de utilizador
      await client.query(
        `INSERT INTO user_profiles (
           user_id, full_name, preferred_name, country, province, municipality,
           location_authorized, preferred_locale, preferred_currency
         )
         VALUES ($1, $2, $2, 'AGO', $3, $4, TRUE, 'pt-AO', 'AOA')
         ON CONFLICT (user_id) DO NOTHING;`,
        [userId, u.fullName, u.province, u.municipality]
      );

      // Inserção da carteira vinculada
      const walletRes = await client.query(
        `INSERT INTO wallets (user_id, currency, status, ledger_balance, available_balance, locked_balance)
         VALUES ($1, 'AOA', 'ACTIVE', 0, 0, 0)
         ON CONFLICT (user_id) DO NOTHING
         RETURNING id;`,
        [userId]
      );

      // Inserção da conta de livro-razão pessoal associada
      if (walletRes.rows.length > 0) {
        const walletId = walletRes.rows[0].id;
        const personalAccountCode = `2001-USER-${userId.slice(0, 8).toUpperCase()}`;
        await client.query(
          `INSERT INTO ledger_accounts (account_code, name, account_type, currency, is_system, user_id, wallet_id, balance)
           VALUES ($1, $2, 'LIABILITY', 'AOA', FALSE, $3, $4, 0)
           ON CONFLICT (account_code) DO NOTHING;`,
          [personalAccountCode, `Carteira de ${u.fullName}`, userId, walletId]
        );
      }
    }

    // 4. Criação de Grupo de Kixikila de Demonstração
    console.log('[DATABASE:SEED] Criando grupo modelo de Kixikila...');
    const leaderUser = createdUsers.find((u) => u.role === 'GROUP_LEADER') || createdUsers[1];
    const member1 = createdUsers.find((u) => u.email === 'membro1@onekixikila.ao') || createdUsers[2];
    const member2 = createdUsers.find((u) => u.email === 'membro2@onekixikila.ao') || createdUsers[3];

    const groupSlug = 'kixikila-solidaria-talatona';
    const groupRes = await client.query(
      `INSERT INTO groups (
         creator_id, leader_id, name, slug, description, status,
         frequency, contribution_amount, currency, min_members, max_members, current_cycle
       )
       VALUES ($1, $1, 'Kixikila Solidária de Talatona', $2, 'Grupo colaborativo de poupança e rotação de Talatona.',
               'FORMATION', 'MONTHLY', 50000, 'AOA', 3, 12, 1)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id;`,
      [leaderUser.id, groupSlug]
    );

    const groupId = groupRes.rows[0].id;

    // Regras vinculativas do grupo
    await client.query(
      `INSERT INTO group_rules (
         group_id, rotation_type, grace_period_days, late_fee_type, late_fee_value,
         allow_early_payout, require_admin_approval_to_join, require_identity_verification
       )
       VALUES ($1, 'FIXED', 2, 'FIXED', 2500, FALSE, TRUE, TRUE)
       ON CONFLICT (group_id) DO NOTHING;`,
      [groupId]
    );

    // Localização aproximada para pesquisa
    await client.query(
      `INSERT INTO group_locations (
         group_id, country, province, municipality, neighborhood,
         approximate_latitude, approximate_longitude, radius_meters, is_publicly_discoverable
       )
       VALUES ($1, 'AGO', 'Luanda', 'Talatona', 'Cidade Financeira', -8.9180000, 13.1890000, 5000, TRUE)
       ON CONFLICT (group_id) DO NOTHING;`,
      [groupId]
    );

    // Adesão do Líder e Membros
    const groupParticipants = [
      { user: leaderUser, role: 'PRIMARY_LEADER', memberRole: 'VICE_LEADER', slot: 1 },
      { user: member1, role: null, memberRole: 'MEMBER', slot: 2 },
      { user: member2, role: null, memberRole: 'MEMBER', slot: 3 }
    ];

    for (const p of groupParticipants) {
      await client.query(
        `INSERT INTO group_memberships (
           group_id, user_id, role, status, joined_at, approved_by, approved_at, slot_number
         )
         VALUES ($1, $2, $3, 'ACTIVE', NOW() AT TIME ZONE 'UTC', $4, NOW() AT TIME ZONE 'UTC', $5)
         ON CONFLICT (group_id, user_id) DO NOTHING;`,
        [groupId, p.user.id, p.memberRole, leaderUser.id, p.slot]
      );

      if (p.role === 'PRIMARY_LEADER') {
        await client.query(
          `INSERT INTO leadership_assignments (
             group_id, user_id, leadership_role, status, assigned_by, assigned_at
           )
           VALUES ($1, $2, 'PRIMARY_LEADER', 'ACTIVE', $2, NOW() AT TIME ZONE 'UTC')
           ON CONFLICT DO NOTHING;`,
          [groupId, p.user.id]
        );
      }
    }

    console.log('[DATABASE:SEED] ✓ Povoamento concluído com sucesso!');
    console.log(`[DATABASE:SEED] Credencial padrão para utilizadores de teste: ${defaultPassword}\n`);
  });
};

if (require.main === module) {
  runDevelopmentSeed()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[DATABASE:SEED:FATAL]', err.message);
      await closePool();
      process.exit(1);
    });
}

module.exports = runDevelopmentSeed;