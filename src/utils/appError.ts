export type CustomErrorContent = {
  message: string;
  context?: { [key: string]: any };
};

/**
 * Represents a custom error that extends the built-in Error class.
 * This abstract class is intended to be a base class for specific custom error implementations.
 *
 * Key properties include:
 * - `statusCode`: The HTTP status code associated with the error.
 * - `errors`: A collection of error details providing additional context about the error.
 * - `logging`: A boolean flag indicating whether the error should be logged.
 *
 * It ensures that any derived class defines the required abstract properties
 * and provides appropriate error handling behavior.
 *
 * The class also preserves the prototype chain by explicitly setting it within the constructor.
 */
export abstract class CustomError extends Error {
  abstract readonly statusCode: number;
  abstract readonly errors: CustomErrorContent[];
  abstract readonly logging: boolean;

  protected constructor(message: string, cause?: unknown) {
    super(message, { cause });

    Object.setPrototypeOf(this, CustomError.prototype);
  }
}

/**
 * Represents an application-specific error that extends the `CustomError` class.
 * This class allows for structured error handling, including optional custom error codes,
 * logging preferences, and additional contextual information for enhanced debugging.
 *
 * The `AppError` class is primarily used to represent client-side errors
 * with a default status code of 400 (Bad Request). It provides additional
 * metadata to describe the error more effectively.
 *
 * Constructor accepts an optional parameter object to customize the error message,
 * code, logging preference, context, and a cause (underlying error).
 */
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
    this.name = "AppError";

    Object.setPrototypeOf(this, AppError.prototype);
  }

  get errors() {
    return [{ message: this.message, context: this._context }];
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
