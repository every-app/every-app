import { builtinToolKind } from "@every-app/toolbus";

/**
 * A gateway tools/list without the workspace tools (`everyapp_workspace_*`
 * and the member's own `everyapp_my_*` / `everyapp_revoke_*`), which the
 * gateway lists to an owner or admin in full mode. Tests about the apps'
 * tools compare the rest; what the workspace tools list and do is
 * server/toolbus/workspace-tools.sqlite.test.ts's.
 */
export function withoutWorkspaceTools(names: string[]): string[] {
  return names.filter((name) => builtinToolKind(name) !== "host");
}
