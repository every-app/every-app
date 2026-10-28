/**
 * Where `everyapp dev --gateway` keeps what it got from a Gateway's OAuth
 * server (docs/design/linked-dev.md §4.1): one entry per Gateway and app,
 * with the client id the CLI registered as, the refresh token and the
 * current access token. `$XDG_CONFIG_HOME/everyapp/linked-dev.json`, else
 * `~/.config/everyapp/linked-dev.json`, mode 0600, never inside an app's
 * directory. A token here opens that app's linked dev route on that
 * Gateway and nothing else; `everyapp dev unlink` revokes and forgets it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LinkedDevEntry {
  /** The Gateway's origin (the OAuth issuer). */
  gateway: string;
  /** The manifest's id. */
  appId: string;
  /** The client id the CLI registered on that Gateway. */
  clientId: string;
  refreshToken: string;
  accessToken: string;
  /** ISO 8601: when `accessToken` stops working. */
  expiresAt: string;
  /** Whom the Gateway said the token speaks for, for the ready block. */
  email?: string;
  organization?: string;
  linkedAt: string;
}

interface StoreFile {
  v: 1;
  entries: LinkedDevEntry[];
}

/** `$XDG_CONFIG_HOME/everyapp/linked-dev.json`, else `~/.config/everyapp/linked-dev.json`. */
export function linkedDevStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config");
  return path.join(configHome, "everyapp", "linked-dev.json");
}

function readFile(file: string): StoreFile {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { v: 1, entries: [] };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as StoreFile).v === 1 &&
      Array.isArray((parsed as StoreFile).entries)
    ) {
      return parsed as StoreFile;
    }
  } catch {
    // An unreadable file is an empty one: the person signs in again.
  }
  return { v: 1, entries: [] };
}

function writeFile(file: string, store: StoreFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

const same = (entry: LinkedDevEntry, gateway: string, appId: string) =>
  entry.gateway === gateway && entry.appId === appId;

export interface LinkedDevStore {
  get(gateway: string, appId: string): LinkedDevEntry | null;
  put(entry: LinkedDevEntry): void;
  remove(gateway: string, appId: string): LinkedDevEntry | null;
  list(): LinkedDevEntry[];
  readonly file: string;
}

/** The store at `file` (the default path unless a test says). */
export function openLinkedDevStore(file = linkedDevStorePath()): LinkedDevStore {
  return {
    file,
    get: (gateway, appId) =>
      readFile(file).entries.find((entry) => same(entry, gateway, appId)) ?? null,
    put: (entry) => {
      const store = readFile(file);
      store.entries = [
        ...store.entries.filter((candidate) => !same(candidate, entry.gateway, entry.appId)),
        entry,
      ];
      writeFile(file, store);
    },
    remove: (gateway, appId) => {
      const store = readFile(file);
      const found = store.entries.find((entry) => same(entry, gateway, appId)) ?? null;
      if (!found) return null;
      store.entries = store.entries.filter((entry) => !same(entry, gateway, appId));
      writeFile(file, store);
      return found;
    },
    list: () => readFile(file).entries,
  };
}
