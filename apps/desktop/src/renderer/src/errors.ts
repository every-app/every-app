// Errors from main, in words for a person. Bridge-free.

/** Electron prefixes errors from main ("Error invoking remote method 'x': Error: …"); drop that. */
export function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, "");
}
