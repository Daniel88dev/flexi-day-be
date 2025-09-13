export type CustomErrorContent = {
  message: string;
  context?: { [key: string]: any };
};

export abstract class CustomError extends Error {
  abstract readonly statusCode: number;
  abstract readonly errors: CustomErrorContent[];
  abstract readonly logging: boolean;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });

    Object.setPrototypeOf(this, CustomError.prototype);
  }
}

export default class AppError extends CustomError {
  private static readonly _statusCode = 400;
  private readonly _code: number;
  private readonly _logging: boolean;
  private readonly _context: { [key: string]: any };

  constructor(params?: {
    code?: number;
    message?: string;
    logging?: boolean;
    context?: { [key: string]: any };
    cause?: unknown;
  }) {
    const { code, message, logging, cause } = params ?? {};
    super(message || "Bad Request", cause);
    this._code = code ?? AppError._statusCode;
    this._logging = logging ?? false;
    this._context = params?.context ?? {};

    Object.setPrototypeOf(this, AppError.prototype);
  }

  get errors() {
    return [{ message: this.message, context: this._context }];
  }

  get statusCode() {
    return this._code;
  }

  get logging() {
    return this._logging;
  }
}
