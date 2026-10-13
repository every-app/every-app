/**
 * An in-memory KVNamespace for tests of the real OAuth library: get (text or
 * JSON), put with `expirationTtl`, `expiration` and `metadata`, delete, and
 * list with prefix, limit and cursor pagination. Expiry follows `Date.now()`,
 * so fake timers drive it.
 */
type Entry = { value: string; metadata?: unknown; expiresAt?: number };

export function createKvFake() {
  const store = new Map<string, Entry>();
  const live = (key: string): Entry | undefined => {
    const entry = store.get(key);
    if (entry?.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };

  const kv = {
    async get(key: string, type?: unknown) {
      const entry = live(key);
      if (!entry) return null;
      const json =
        type === "json" ||
        (typeof type === "object" &&
          type !== null &&
          (type as { type?: string }).type === "json");
      return json ? JSON.parse(entry.value) : entry.value;
    },
    async put(
      key: string,
      value: string,
      options: {
        expirationTtl?: number;
        expiration?: number;
        metadata?: unknown;
      } = {},
    ) {
      const expiresAt =
        options.expirationTtl !== undefined
          ? Date.now() + options.expirationTtl * 1000
          : options.expiration !== undefined
            ? options.expiration * 1000
            : undefined;
      store.set(key, {
        value,
        ...(options.metadata !== undefined
          ? { metadata: options.metadata }
          : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(
      options: { prefix?: string; limit?: number; cursor?: string } = {},
    ) {
      const names = [...store.keys()]
        .filter((name) => live(name))
        .filter((name) => !options.prefix || name.startsWith(options.prefix))
        .sort();
      const start = options.cursor ? Number(options.cursor) : 0;
      const limit = options.limit ?? 1000;
      const page = names.slice(start, start + limit);
      const done = start + limit >= names.length;
      return {
        keys: page.map((name) => {
          const entry = store.get(name)!;
          return {
            name,
            ...(entry.metadata !== undefined
              ? { metadata: entry.metadata }
              : {}),
            ...(entry.expiresAt !== undefined
              ? { expiration: Math.floor(entry.expiresAt / 1000) }
              : {}),
          };
        }),
        list_complete: done,
        ...(done ? {} : { cursor: String(start + limit) }),
      };
    },
  };
  return { kv: kv as unknown as KVNamespace, store };
}
