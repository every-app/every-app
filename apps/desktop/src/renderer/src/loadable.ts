// Query state as the screens' Loadable (@every-app/desktop-ui), kept bridge- and React-free for the tests.

import type { UseQueryResult } from "@tanstack/react-query";
import { cleanError } from "./errors";

/** The same shape as @every-app/desktop-ui's Loadable. */
export type Loadable<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

export function loadable<T, R = T>(query: UseQueryResult<T>, select?: (data: T) => R): Loadable<R> {
  if (query.isPending) return { status: "loading" };
  // A failed refetch keeps what's already on screen (offline, say); only a first load errors.
  if (query.isError && query.data === undefined) return { status: "error", message: cleanError(query.error) };
  const data = query.data as T;
  return { status: "ready", data: select ? select(data) : (data as unknown as R) };
}
