const env = require('./env');

const limitsConfig = Object.freeze({
  // Limites financeiros operacionais em Kwanzas (AOA) por nível de verificação de identidade (KYC)
  financial: {
    currency: 'AOA',
    tiers: {
      // Nível 1: Utilizador apenas com telemóvel e email confirmados (sem Bilhete de Identidade verificado)
      TIER_1_UNVERIFIED: {
        maxSingleDeposit: 50000,        // 50.000 Kz
        maxDailyDeposit: 100000,        // 100.000 Kz
        maxMonthlyVolume: 300000,       // 300.000 Kz
        maxSingleTransfer: 25000,       // 25.000 Kz
        maxDailyTransfer: 50000,        // 50.000 Kz
        canWithdraw: false,             // Levantamentos bloqueados até aprovação de KYC
        maxActiveGroups: 2
      },
      // Nível 2: Identidade verificada e aprovada por documento oficial (Bilhete de Identidade / Foto)
      TIER_2_VERIFIED: {
        maxSingleDeposit: 1000000,      // 1.000.000 Kz
        maxDailyDeposit: 3000000,       // 3.000.000 Kz
        maxMonthlyVolume: 10000000,     // 10.000.000 Kz
        maxSingleTransfer: 500000,      // 500.000 Kz
        maxDailyTransfer: 1500000,      // 1.500.000 Kz
        maxSingleWithdrawal: 500000,    // 500.000 Kz
        maxDailyWithdrawal: 1000000,    // 1.000.000 Kz
        canWithdraw: true,
        maxActiveGroups: 10
      },
      // Nível 3: Utilizador com histórico consolidado e diligência reforçada (KYC Avançado / Liderança)
      TIER_3_ENHANCED: {
        maxSingleDeposit: 5000000,      // 5.000.000 Kz
        maxDailyDeposit: 15000000,      // 15.000.000 Kz
        maxMonthlyVolume: 50000000,     // 50.000.000 Kz
        maxSingleTransfer: 2500000,     // 2.500.000 Kz
        maxDailyTransfer: 5000000,      // 5.000.000 Kz
        maxSingleWithdrawal: 2500000,   // 2.500.000 Kz
        maxDailyWithdrawal: 5000000,    // 5.000.000 Kz
        canWithdraw: true,
        maxActiveGroups: 30
      }
    }
  },

  // Parâmetros estruturais dos Grupos de Kixikila
  groups: {
    minMembers: 3,
    maxMembers: 50,
    minContributionAmount: 1000,        // 1.000 Kz mínimo por quota
    maxContributionAmount: 2500000,     // 2.500.000 Kz máximo por quota
    allowedFrequencies: ['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY'],
    defaultGracePeriodDays: 2,          // Período de tolerância antes de penalização/atraso
    maxAdminsPerGroup: 3
  },

  // Limites estritos de ficheiros e multimédia
  uploads: {
    maxDocumentSizeBytes: env.MAX_DOCUMENT_SIZE_BYTES, // 5.242.880 bytes (5 MB exatos)
    maxAudioSizeBytes: env.MAX_AUDIO_SIZE_BYTES,       // 10.485.760 bytes (10 MB)
    maxImageSizeBytes: env.MAX_IMAGE_SIZE_BYTES,       // 5.242.880 bytes (5 MB)
    maxAudioDurationSeconds: 120                       // 2 minutos de gravação
  },

  // Validade de tokens temporários e QR Codes
  tokens: {
    groupInvitationTtlSeconds: 604800,  // 7 dias
    paymentQrTtlSeconds: 900,           // 15 minutos (uso único e dinâmico)
    passwordResetTtlSeconds: 1800,      // 30 minutos
    accountVerificationOtpTtlSeconds: 600 // 10 minutos
  },

  // Limites de comunicação em tempo real no chat
  chat: {
    maxTextMessageLength: 2000,
    maxMessagesPerMinute: 30,
    historyPageSize: 50
  }
});

module.exports = limitsConfig;