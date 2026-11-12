/** A text column holding a JSON array of strings (scopes), read; [] when it doesn't read as one. */
export function storedStrings(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((each): each is string => typeof each === "string")
      : [];
  } catch {
    return [];
  }
}
