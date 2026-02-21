export type MessagePayload = Record<string, unknown>;

export function parseMessagePayload(data: unknown): MessagePayload | null {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as MessagePayload;
  }

  if (typeof data !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as MessagePayload;
    }
  } catch {
    return null;
  }

  return null;
}
