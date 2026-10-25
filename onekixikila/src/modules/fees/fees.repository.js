const { query, queryOne, queryClient, queryOneClient } = require('../../database/query');

/**
 * Repositório de persistência SQL para a tabela `fees`.
 * Executa consultas parametrizadas diretas no Neon PostgreSQL para gestão da tabela de tarifas,
 * histórico de versionamento de comissões e busca de taxas ativas por tipo de operação financeira.
 */
class FeesRepository {
  /**
   * Insere uma nova tarifa na matriz de taxas da plataforma.
   *
   * @param {object} params
   * @param {string} params.feeCode - Código identificador único (ex: 'FEE_WITHDRAWAL_BANK')
   * @param {string} params.name - Nome descritivo da tarifa
   * @param {string} params.operationType - 'DEPOSIT', 'WITHDRAWAL', 'INTERNAL_TRANSFER', etc.
   * @param {string} [params.calculationType='FLAT'] - 'FLAT', 'PERCENTAGE', 'HYBRID'
   * @param {number|bigint} [params.flatAmount=0] - Parcela fixa em Kwanzas (AOA)
   * @param {number} [params.basisPoints=0] - Parcela percentual em pontos-base (100 bps = 1.00%)
   * @param {number|bigint} [params.minFee=0] - Montante piso em Kwanzas
   * @param {number|bigint|null} [params.maxFee=null] - Montante teto em Kwanzas
   * @param {string} [params.currency='AOA']
   * @param {boolean} [params.isActive=true]
   * @param {Date|null} [params.effectiveFrom]
   * @param {Date|null} [params.effectiveTo]
   * @param {import('pg').PoolClient} [client] - Cliente transacional opcional
   * @returns {Promise<object>}
   */
  async createFee(params, client = null) {
    const {
      feeCode,
      name,
      operationType,
      calculationType = 'FLAT',
      flatAmount = 0,
      basisPoints = 0,
      minFee = 0,
      maxFee = null,
      currency = 'AOA',
      isActive = true,
      effectiveFrom = null,
      effectiveTo = null
    } = params;

    const text = `
      INSERT INTO fees (
        fee_code,
        name,
        operation_type,
        calculation_type,
        flat_amount,
        basis_points,
        min_fee,
        max_fee,
        currency,
        is_active,
        effective_from,
        effective_to,
        version
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, NOW() AT TIME ZONE 'UTC'), $12, 1)
      RETURNING *;
    `;

    const values = [
      feeCode,
      name,
      operationType,
      calculationType,
      flatAmount,
      basisPoints,
      minFee,
      maxFee,
      currency,
      isActive,
      effectiveFrom,
      effectiveTo
    ];

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Localiza uma tarifa pelo seu código canónico exclusivo.
   *
   * @param {string} feeCode
   * @param {import('pg').PoolClient} [client]
   */
  async findByCode(feeCode, client = null) {
    const text = `
      SELECT 
        id,
        fee_code,
        name,
        operation_type,
        calculation_type,
        flat_amount,
        basis_points,
        min_fee,
        max_fee,
        currency,
        is_active,
        effective_from,
        effective_to,
        version,
        created_at,
        updated_at
      FROM fees
      WHERE fee_code = $1;
    `;

    return client ? queryOneClient(client, text, [feeCode]) : queryOne(text, [feeCode]);
  }

  /**
   * Localiza uma tarifa ativa e vigente aplicável a determinado tipo de operação financeira.
   *
   * @param {string} operationType - 'DEPOSIT', 'WITHDRAWAL', 'INTERNAL_TRANSFER', etc.
   * @param {import('pg').PoolClient} [client]
   */
  async findActiveByOperationType(operationType, client = null) {
    const text = `
      SELECT 
        id,
        fee_code,
        name,
        operation_type,
        calculation_type,
        flat_amount,
        basis_points,
        min_fee,
        max_fee,
        currency,
        is_active,
        effective_from,
        effective_to,
        version
      FROM fees
      WHERE operation_type = $1
        AND is_active = TRUE
        AND effective_from <= (NOW() AT TIME ZONE 'UTC')
        AND (effective_to IS NULL OR effective_to > (NOW() AT TIME ZONE 'UTC'))
      ORDER BY version DESC, effective_from DESC
      LIMIT 1;
    `;

    return client ? queryOneClient(client, text, [operationType]) : queryOne(text, [operationType]);
  }

  /**
   * Atualiza os parâmetros de uma tarifa, incrementando automaticamente a versão para rastreio de auditoria.
   *
   * @param {string} feeCode
   * @param {object} updateData
   * @param {import('pg').PoolClient} [client]
   */
  async updateFee(feeCode, updateData, client = null) {
    const fields = ['version = version + 1', 'updated_at = NOW() AT TIME ZONE \'UTC\''];
    const values = [];
    let paramIndex = 1;

    const fieldMap = {
      name: 'name',
      calculationType: 'calculation_type',
      flatAmount: 'flat_amount',
      basisPoints: 'basis_points',
      minFee: 'min_fee',
      maxFee: 'max_fee',
      isActive: 'is_active',
      effectiveFrom: 'effective_from',
      effectiveTo: 'effective_to'
    };

    for (const [prop, column] of Object.entries(fieldMap)) {
      if (updateData[prop] !== undefined) {
        fields.push(`${column} = $${paramIndex}`);
        values.push(updateData[prop]);
        paramIndex += 1;
      }
    }

    values.push(feeCode);
    const text = `
      UPDATE fees
      SET ${fields.join(', ')}
      WHERE fee_code = $${paramIndex}
      RETURNING *;
    `;

    return client ? queryOneClient(client, text, values) : queryOne(text, values);
  }

  /**
   * Lista todas as tarifas cadastradas na plataforma.
   *
   * @param {boolean|null} [onlyActive=null]
   * @param {import('pg').PoolClient} [client]
   * @returns {Promise<Array<object>>}
   */
  async listAllFees(onlyActive = null, client = null) {
    let text = `
      SELECT 
        id,
        fee_code,
        name,
        operation_type,
        calculation_type,
        flat_amount,
        basis_points,
        min_fee,
        max_fee,
        currency,
        is_active,
        effective_from,
        effective_to,
        version,
        created_at
      FROM fees
    `;

    const values = [];
    if (onlyActive === true) {
      text += ` WHERE is_active = TRUE AND effective_from <= (NOW() AT TIME ZONE 'UTC') AND (effective_to IS NULL OR effective_to > (NOW() AT TIME ZONE 'UTC'))`;
    }

    text += ` ORDER BY operation_type ASC, fee_code ASC;`;

    const result = client ? await queryClient(client, text, values) : await query(text, values);
    return result.rows;
  }
}

// Instância singleton do repositório de taxas
const feesRepository = new FeesRepository();

module.exports = feesRepository;