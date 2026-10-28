export type CustomErrorContent = {
  message: string;
  /** Internal context — logged, NEVER sent to clients. May contain auth / PII. */
  context?: object;
  /** Explicitly safe-to-send-to-client context (e.g. conflictingDays). */
  publicContext?: { [key: string]: unknown };
};

export abstract class CustomError extends Error {
  abstract readonly statusCode: number;
  abstract readonly errors: CustomErrorContent[];
  abstract readonly logging: boolean;

  protected constructor(message: string, cause?: unknown) {
    super(message, { cause });

    Object.setPrototypeOf(this, CustomError.prototype);
  }
}

export default class AppError extends CustomError {
  private static readonly _statusCode = 400;
  private readonly _code: number;
  private readonly _logging: boolean;
  private readonly _context: object;
  private readonly _publicContext: { [key: string]: unknown };

  constructor(params?: {
    code?: number;
    message?: string;
    logging?: boolean;
    /** Internal context — logged, never returned to clients. */
    context?: object;
    /** Safe-to-expose fields returned alongside the error message. */
    publicContext?: { [key: string]: unknown };
    cause?: unknown;
  }) {
    const { code, message, logging, cause } = params ?? {};
    super(message || "Bad Request", cause);
    this._code = code ?? AppError._statusCode;
    this._logging = logging ?? false;
    this._context = params?.context ?? {};
    this._publicContext = params?.publicContext ?? {};
    this.name = "AppError";

    Object.setPrototypeOf(this, AppError.prototype);
  }

  get errors() {
    return [
      {
        message: this.message,
        context: this._context,
        publicContext: this._publicContext,
      },
    ];
  }

  get statusCode() {
    return this._code;
  }

  get code() {
    return this._code;
  }

  get logging() {
    return this._logging;
  }
}

/** A logged refusal whose `context.code` tells the client which one it was. */
export const refuse = (code: number, publicCode: string, message: string, context: object) =>
  new AppError({ code, message, logging: true, context, publicContext: { code: publicCode } });
