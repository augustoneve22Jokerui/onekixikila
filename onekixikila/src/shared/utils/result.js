/**
 * Implementação do padrão funcional Result (Ok / Fail) para a plataforma OneKixikila.
 * Permite que serviços de domínio e operações financeiras comuniquem sucessos ou falhas
 * de forma tipada, previsível e explícita, evitando lançamentos descontrolados de exceções
 * em fluxos esperados de validação e regras de negócio.
 */
class Result {
  /**
   * Construtor protegido. Utilize as fábricas estáticas Result.ok() ou Result.fail().
   *
   * @param {boolean} isSuccess
   * @param {any} [value=null] - Carga útil retornada em caso de sucesso
   * @param {any} [error=null] - Mensagem, código ou objeto de erro em caso de falha
   * @param {string} [code=null] - Código canónico de erro da aplicação
   * @param {number} [statusCode=200] - Sugestão de status code HTTP correspondente
   */
  constructor(isSuccess, value = null, error = null, code = null, statusCode = 200) {
    if (isSuccess && error) {
      throw new Error('Invariante do Result violada: um resultado bem-sucedido não pode conter erro.');
    }
    if (!isSuccess && !error) {
      throw new Error('Invariante do Result violada: uma falha deve obrigatoriamente especificar um erro.');
    }

    this.isSuccess = Boolean(isSuccess);
    this.isFailure = !this.isSuccess;
    this.value = this.isSuccess ? value : null;
    this.error = this.isFailure ? error : null;
    this.code = code || (this.isSuccess ? 'SUCCESS' : 'OPERATION_FAILED');
    this.statusCode = statusCode;

    Object.freeze(this);
  }

  /**
   * Cria uma instância de sucesso encapsulando o valor retornado.
   *
   * @template T
   * @param {T} [value=null] - Dados retornados pela operação
   * @param {number} [statusCode=200] - Código HTTP associado
   * @returns {Result}
   */
  static ok(value = null, statusCode = 200) {
    return new Result(true, value, null, 'SUCCESS', statusCode);
  }

  /**
   * Cria uma instância de falha encapsulando a descrição do erro e o código.
   *
   * @param {string|object|Error} error - Mensagem ou objeto descritivo da falha
   * @param {string} [code='OPERATION_FAILED'] - Código canónico de erro
   * @param {number} [statusCode=400] - Código HTTP correspondente
   * @returns {Result}
   */
  static fail(error, code = 'OPERATION_FAILED', statusCode = 400) {
    const errorMessage = error instanceof Error ? error.message : error;
    return new Result(false, null, errorMessage, code, statusCode);
  }

  /**
   * Executa uma função e encapsula automaticamente o resultado em Result.ok()
   * ou captura a exceção em Result.fail().
   *
   * @param {Function} fn
   * @returns {Result}
   */
  static try(fn) {
    try {
      const value = fn();
      return Result.ok(value);
    } catch (err) {
      return Result.fail(err.message, err.code || 'UNHANDLED_EXCEPTION', err.statusCode || 500);
    }
  }

  /**
   * Encapsula uma Promise assíncrona, resolvendo para Result.ok() ou capturando rejeição em Result.fail().
   *
   * @param {Promise<any>} promise
   * @returns {Promise<Result>}
   */
  static async fromPromise(promise) {
    try {
      const data = await promise;
      return Result.ok(data);
    } catch (err) {
      return Result.fail(err.message, err.code || 'ASYNC_OPERATION_FAILED', err.statusCode || 500);
    }
  }

  /**
   * Transforma o valor do resultado caso seja um sucesso, mantendo a falha inalterada.
   *
   * @param {(value: any) => any} transformFn
   * @returns {Result}
   */
  map(transformFn) {
    if (this.isFailure) {
      return this;
    }
    try {
      const transformed = transformFn(this.value);
      return Result.ok(transformed, this.statusCode);
    } catch (err) {
      return Result.fail(err.message, 'TRANSFORMATION_ERROR', 500);
    }
  }

  /**
   * Encadeia outra operação que retorna um Result (Monadic FlatMap).
   *
   * @param {(value: any) => Result} chainFn
   * @returns {Result}
   */
  flatMap(chainFn) {
    if (this.isFailure) {
      return this;
    }
    const nextResult = chainFn(this.value);
    if (!(nextResult instanceof Result)) {
      throw new TypeError('O retorno de flatMap deve ser obrigatoriamente uma instância de Result.');
    }
    return nextResult;
  }

  /**
   * Retorna o valor em caso de sucesso ou lança uma exceção caso seja uma falha.
   *
   * @returns {any}
   * @throws {Error}
   */
  unwrap() {
    if (this.isFailure) {
      const error = new Error(typeof this.error === 'string' ? this.error : JSON.stringify(this.error));
      error.code = this.code;
      error.statusCode = this.statusCode;
      throw error;
    }
    return this.value;
  }

  /**
   * Retorna o valor em caso de sucesso ou o valor padrão informado em caso de falha.
   *
   * @param {any} defaultValue
   * @returns {any}
   */
  unwrapOr(defaultValue) {
    return this.isSuccess ? this.value : defaultValue;
  }

  /**
   * Avalia e ramifica o fluxo tratando simultaneamente os cenários de sucesso e falha (Pattern Matching).
   *
   * @param {object} matcher
   * @param {(value: any) => any} matcher.ok - Função executada em caso de sucesso
   * @param {(error: any, code: string, statusCode: number) => any} matcher.fail - Função executada em caso de falha
   * @returns {any}
   */
  match(matcher) {
    if (!matcher || typeof matcher.ok !== 'function' || typeof matcher.fail !== 'function') {
      throw new TypeError('O método match exige um objeto com as funções ok(value) e fail(error, code, statusCode).');
    }

    if (this.isSuccess) {
      return matcher.ok(this.value);
    }
    return matcher.fail(this.error, this.code, this.statusCode);
  }

  /**
   * Serialização padronizada para respostas JSON de controladores da API.
   *
   * @returns {object}
   */
  toJSON() {
    if (this.isSuccess) {
      return {
        success: true,
        data: this.value
      };
    }
    return {
      success: false,
      error: {
        code: this.code,
        message: this.error,
        statusCode: this.statusCode
      }
    };
  }
}

module.exports = Result;