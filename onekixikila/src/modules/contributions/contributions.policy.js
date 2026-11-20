const { USER_ROLES } = require('../../shared/constants/roles');
const {
  OBLIGATION_STATUSES,
  CONTRIBUTION_STATUSES,
  GROUP_STATUSES,
  WALLET_STATUSES
} = require('../../shared/constants/statuses');

/**
 * Políticas de autorização, integridade financeira e regras de solvência
 * para o módulo de Contribuições e Pagamento de Quotas de Kixikila.
 */
class ContributionsPolicy {
  /**
   * Avalia se um membro pode efetuar o pagamento da sua quota de Kixikila.
   * Valida estado da conta, adimplência do grupo, status da obrigação e restrições cautelares.
   *
   * @param {object} actingUser - Utilizador autenticado (req.user)
   * @param {object} obligationDetails - Dados consolidados da obrigação (findObligationWithDetails)
   * @returns {{ allowed: boolean, reason?: string, statusCode?: number }}
   */
  canPayContribution(actingUser, obligationDetails) {
    if (!actingUser || !obligationDetails) {
      return { allowed: false, reason: 'Utilizador ou obrigação de quota não identificados.', statusCode: 400 };
    }

    // Apenas o próprio membro titular da obrigação ou administradores gerais podem liquidar
    if (actingUser.id !== obligationDetails.user_id && actingUser.role !== USER_ROLES.ADMIN) {
      return {
        allowed: false,
        reason: 'Não possui autorização para liquidar obrigações financeiras de outro utilizador.',
        statusCode: 403
      };
    }

    // Validação do estado do grupo de Kixikila
    if (obligationDetails.group_status !== GROUP_STATUSES.ACTIVE) {
      return {
        allowed: false,
        reason: `O grupo encontra-se no estado [${obligationDetails.group_status}]. Não são aceites contribuições fora de ciclos ativos.`,
        statusCode: 409
      };
    }

    // Validação do estado da filiação do membro no grupo
    if (obligationDetails.membership_status === 'SUSPENDED' || obligationDetails.membership_status === 'EXPELLED') {
      return {
        allowed: false,
        reason: `A sua filiação no grupo encontra-se no estado [${obligationDetails.membership_status}]. Pagamento bloqueado.`,
        statusCode: 403
      };
    }

    if (obligationDetails.is_contribution_restricted) {
      return {
        allowed: false,
        reason: 'A sua conta possui restrição cautelar de contribuição ativa neste grupo. Contacte a liderança.',
        statusCode: 403
      };
    }

    // Validação da obrigação individual
    if (obligationDetails.obligation_status === OBLIGATION_STATUSES.PAID) {
      return {
        allowed: false,
        reason: 'Esta quota de Kixikila já se encontra integralmente liquidada.',
        statusCode: 409
      };
    }

    if (obligationDetails.obligation_status === OBLIGATION_STATUSES.EXCUSED) {
      return {
        allowed: false,
        reason: 'Esta quota foi formalmente dispensada pelo regulamento do grupo.',
        statusCode: 409
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se a carteira interna possui solvência e saldo disponível suficiente
   * para liquidar a quota e eventuais multas de mora associadas.
   *
   * @param {object} obligationDetails
   * @param {bigint|number} totalRequiredAmount - Montante total exigido (quota + multas)
   * @returns {{ allowed: boolean, reason?: string, statusCode?: number }}
   */
  canPayWithInternalWallet(obligationDetails, totalRequiredAmount) {
    if (!obligationDetails.wallet_id) {
      return {
        allowed: false,
        reason: 'Carteira digital interna não localizada para este utilizador.',
        statusCode: 404
      };
    }

    if (obligationDetails.wallet_status !== WALLET_STATUSES.ACTIVE) {
      return {
        allowed: false,
        reason: `A sua carteira interna encontra-se no estado [${obligationDetails.wallet_status}]. Operações financeiras bloqueadas.`,
        statusCode: 403
      };
    }

    const availableBalance = BigInt(obligationDetails.wallet_available_balance || 0);
    const required = BigInt(totalRequiredAmount);

    if (availableBalance < required) {
      const missing = required - availableBalance;
      return {
        allowed: false,
        reason: `Saldo disponível insuficiente na carteira interna. Faltam ${Number(missing).toLocaleString('pt-AO')} Kz. Efetue um depósito prévio.`,
        statusCode: 402
      };
    }

    return { allowed: true };
  }

  /**
   * Avalia se o utilizador possui autorização para consultar os detalhes de uma contribuição (Anti-IDOR).
   *
   * @param {object} actingUser
   * @param {object} contributionRecord
   * @param {boolean} [isGroupLeader=false]
   * @returns {boolean}
   */
  canViewContribution(actingUser, contributionRecord, isGroupLeader = false) {
    if (!actingUser || !contributionRecord) {
      return false;
    }

    if (actingUser.role === USER_ROLES.ADMIN || actingUser.role === USER_ROLES.AUDITOR) {
      return true;
    }

    if (actingUser.id === contributionRecord.user_id) {
      return true;
    }

    return Boolean(isGroupLeader);
  }

  /**
   * Avalia se o utilizador atuante detém poderes de liderança ou administração
   * para dispensar ou perdoar a multa de mora de uma obrigação.
   *
   * @param {object} actingUser
   * @param {object} obligationDetails
   * @returns {{ allowed: boolean, reason?: string }}
   */
  canWaiveLateFee(actingUser, obligationDetails) {
    if (!actingUser || !obligationDetails) {
      return { allowed: false, reason: 'Parâmetros incompletos para dispensa de multa.' };
    }

    if (actingUser.role === USER_ROLES.ADMIN) {
      return { allowed: true };
    }

    if (actingUser.id !== obligationDetails.leader_id) {
      return {
        allowed: false,
        reason: 'Apenas o Líder titular do grupo ou um Administrador podem deliberar sobre o perdão de multas de mora.'
      };
    }

    const assessedFee = BigInt(obligationDetails.late_fee_assessed || 0);
    if (assessedFee <= 0n) {
      return {
        allowed: false,
        reason: 'Esta obrigação não possui penalizações ou multas de mora aplicadas.'
      };
    }

    if (obligationDetails.obligation_status === OBLIGATION_STATUSES.PAID) {
      return {
        allowed: false,
        reason: 'Não é possível dispensar multas de uma quota que já foi quitada.'
      };
    }

    return { allowed: true };
  }
}

// Instância singleton da política de contribuições
const contributionsPolicy = new ContributionsPolicy();

module.exports = contributionsPolicy;