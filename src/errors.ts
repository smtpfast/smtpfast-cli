export const EXIT_OK = 0;
export const EXIT_API = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERRUPTED = 130;

/** A mistake in how the command was called, or missing setup. Exit code 2. */
export class UsageError extends Error {
  readonly exitCode = EXIT_USAGE;
  constructor(
    message: string,
    readonly hint?: string,
    /** False for setup problems, where pointing at --help does not help. */
    readonly showUsage = true,
  ) {
    super(message);
    this.name = "UsageError";
  }
}

/** The API answered with an error status. Exit code 1. */
export class ApiError extends Error {
  readonly exitCode = EXIT_API;
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
    readonly headers: Headers,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** The scope named in messages like "API key does not have contact:write scope". */
  get missingScope(): string | undefined {
    return /does not have ([a-z_-]+:[a-z_-]+) scope/i.exec(this.message)?.[1];
  }
}

/** Anything else that stops a command: network failures, timeouts, unreadable files. Exit code 1. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT_API,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}
