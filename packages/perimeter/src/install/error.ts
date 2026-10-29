/** A release installation failure, independent of its terminal or browser UI. */
export class InstallationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: {
      fix?: string;
      rerun?: string;
      rerunNote?: string;
      data?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "InstallationError";
  }
}

/** The registry operations needed by the installer; remote D1 or a local binding. */
export interface InstallationDatabase {
  run(
    statements: readonly {
      sql: string;
      params?: Array<string | number | null>;
    }[],
  ): Promise<Record<string, unknown>[][]>;
}
