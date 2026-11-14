/**
 * Composio as Manage workspace → Providers, Your connections → Accounts,
 * the `everyapp_workspace_composio` and `everyapp_provider_composio*`
 * tools and the CLI call it (docs/design/2026-11-composio.md). The switch
 * is an owner's or admin's. A link is one person's, and a person acts
 * only on their own. Linking is Composio's sign-in link, so nobody types
 * a key. Nothing here returns the key or the sign-in id; the sign-in's
 * page is returned once, by the start, to the person who started it.
 * Nothing changes an account at Composio.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import {
  composioProviderIds,
  composioServicesOf,
  oauthPreset,
  type ProviderRegistry,
} from "@every-app/sdk/internal";
import { ComposioLinkState } from "@/schemas/composio";
import { forgetComposioSwitch } from "@/server/app-setup";
import { PublicError } from "@/server/errors";
import type { Fetch } from "@/server/oauth/tokens";
import type { OrgContext } from "@/server/organization/orgContext";
import { gatewayProviders } from "@/server/providers";
import { ComposioLinkRepository as Links } from "@/server/repositories/ComposioLinkRepository";
import { OrgSettingsRepository } from "@/server/repositories/OrgSettingsRepository";
import { ProviderConnectionRepository as Connections } from "@/server/repositories/ProviderConnectionRepository";
import { SealingUnavailableError } from "@/server/secrets/sealed";
import { composioClient, composioSignInUrl, SignInState } from "./client";
import {
  ComposioUnlinkReason,
  composioAccounts,
  dropComposioLink,
  type ComposioPerson,
} from "./link";

/** The organization's switch, with what turning it off would delete. */
interface ComposioSwitch {
  composio: "on" | "off";
  /** How many people linked their Composio. */
  links: number;
  /** How many connections were made through Composio. */
  connections: number;
}

/** One provider found in a person's Composio. */
interface ComposioProviderFound {
  providerId: string;
  providerName: string;
  /** Its services connected there, each with the accounts' names. */
  services: { slug: string; label: string; accounts: string[] }[];
  /** Whether the person's connection to the provider is one made through Composio. */
  connected: boolean;
}

/**
 * A person's link as the page, the tools and the CLI show it: never the
 * key. `account` is how Composio names the linked account. `providers` is
 * what is in their Composio that EveryApp supports, when it was asked for
 * and Composio answered; null otherwise.
 */
export interface ComposioStatus {
  /** Whether the organization turned Composio on. */
  composio: "on" | "off";
  linked: boolean;
  account: string | null;
  providers: ComposioProviderFound[] | null;
}

type ComposioLinkResult =
  | { state: ComposioLinkState.Waiting }
  | { state: ComposioLinkState.Linked; status: ComposioStatus }
  | { state: ComposioLinkState.Expired };

const send: Fetch = (request) => fetch(request);

function personOf(org: OrgContext): ComposioPerson {
  return { organizationId: org.orgId, userId: org.userId };
}

function requireAdmin(org: OrgContext): void {
  if (org.role !== "owner" && org.role !== "admin") {
    throw new PublicError(
      "ADMIN_REQUIRED",
      "Only an owner or admin can turn Composio on or off",
    );
  }
}

function unavailable(): PublicError {
  return new PublicError(
    "COMPOSIO_UNAVAILABLE",
    "Composio could not be reached. Try again.",
  );
}

/** Run a write that seals; a Gateway that can't seal says so. */
async function sealing<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof SealingUnavailableError) {
      throw new PublicError(
        "SEALING_UNAVAILABLE",
        "This Gateway can't seal a secret: BETTER_AUTH_SECRET is not set",
      );
    }
    throw error;
  }
}

function providerName(registry: ProviderRegistry, providerId: string): string {
  const capability = registry.get(providerId);
  if (capability && capability.mode !== "service") return capability.label;
  return oauthPreset(providerId)?.label ?? providerId;
}

/** The organization's switch, and what turning it off would delete. Owners and admins. */
export async function composioSwitch(org: OrgContext): Promise<ComposioSwitch> {
  requireAdmin(org);
  return {
    composio: (await OrgSettingsRepository.isComposioOn(org.orgId))
      ? "on"
      : "off",
    links: await Links.countForOrganization(org.orgId),
    connections: (await Connections.listComposio(org.orgId)).length,
  };
}

/**
 * Turn Composio on or off for the organization. Owners and admins.
 * Turning it off deletes every link in the organization and every
 * connection made through Composio, with its access: `removed` counts
 * them.
 */
export async function setComposio(
  org: OrgContext,
  on: boolean,
): Promise<{
  composio: "on" | "off";
  changed: boolean;
  removed: { links: number; connections: number };
}> {
  requireAdmin(org);
  const before = await OrgSettingsRepository.isComposioOn(org.orgId);
  const removed = { links: 0, connections: 0 };
  if (!on) {
    // Whatever the switch says: turning it off leaves nothing behind.
    removed.connections = await Connections.removeComposio(org.orgId);
    removed.links = await Links.removeForOrganization(org.orgId);
  }
  if (on !== before) {
    await OrgSettingsRepository.setComposio({
      organizationId: org.orgId,
      on,
      updatedBy: org.userId,
    });
    forgetComposioSwitch(org.orgId);
    logEvent("organization.composio_changed", {
      organizationId: org.orgId,
      by: org.userId,
      composio: on,
      ...removed,
    });
  }
  return { composio: on ? "on" : "off", changed: on !== before, removed };
}

/**
 * Turn Composio off, unless that would delete a link or a connection and
 * the caller has not confirmed: then nothing changes, and what it would
 * delete comes back as `needsConfirm` for the caller to ask about. The
 * one rule behind the page's confirm and the tool's `confirm`.
 */
export async function turnComposioOff(
  org: OrgContext,
  confirmed: boolean,
): Promise<
  | Awaited<ReturnType<typeof setComposio>>
  | { needsConfirm: { links: number; connections: number } }
> {
  if (!confirmed) {
    const { links, connections } = await composioSwitch(org);
    if (links + connections > 0)
      return { needsConfirm: { links, connections } };
  }
  return setComposio(org, false);
}

/**
 * Start linking: a sign-in at Composio, kept until the person approves it
 * there. Starting again replaces the one waiting.
 */
export async function startComposioLink(
  org: OrgContext,
  fetchUpstream: Fetch = send,
): Promise<{ url: string; expiresAt: number }> {
  const person = personOf(org);
  if (!(await OrgSettingsRepository.isComposioOn(org.orgId))) {
    throw new PublicError(
      "COMPOSIO_OFF",
      "Composio is off for this organization. An owner or admin turns it on under Manage workspace → Providers.",
    );
  }
  if (await Links.find(person)) {
    throw new PublicError(
      "COMPOSIO_ALREADY_LINKED",
      "Composio is already linked. Unlink it first.",
    );
  }
  const created = await composioClient(fetchUpstream).createSignIn();
  if (!created.ok) throw unavailable();
  const { id, expiresAt } = created.value;
  await sealing(() =>
    Links.putRequest({ ...person, signInId: id, expiresAt }, env as never),
  );
  logEvent("composio.link_started", { org: org.orgId, user_id: org.userId });
  return { url: composioSignInUrl(id), expiresAt };
}

/**
 * See whether the person approved the sign-in they started, and link when
 * they did. Composio hands the key out once, so a failure after that loses
 * it: the sign-in is dropped and the person starts again. Linking adds no
 * connection.
 */
export async function finishComposioLink(
  org: OrgContext,
  fetchUpstream: Fetch = send,
): Promise<ComposioLinkResult> {
  const person = personOf(org);
  const linked = async (): Promise<ComposioLinkResult> => {
    const status = await composioStatus(org, { list: true }, fetchUpstream);
    // Reading what is in it found the key refused: no link after all.
    return status.linked
      ? { state: ComposioLinkState.Linked, status }
      : { state: ComposioLinkState.Expired };
  };
  if (await Links.find(person)) return linked();
  const request = await Links.findRequest(person, env as never);
  if (
    !request ||
    request.signInId === null ||
    request.expiresAt <= Date.now() ||
    !(await OrgSettingsRepository.isComposioOn(org.orgId))
  ) {
    await Links.removeRequest(person);
    return { state: ComposioLinkState.Expired };
  }
  const client = composioClient(fetchUpstream);
  const signIn = await client.readSignIn(request.signInId);
  if (!signIn.ok) throw unavailable();
  switch (signIn.value.state) {
    case SignInState.Pending:
      return { state: ComposioLinkState.Waiting };
    case SignInState.Gone:
      await Links.removeRequest(person);
      return { state: ComposioLinkState.Expired };
    case SignInState.Used:
      // Another check picked the key up: linked when it has finished.
      await Links.removeRequest(person);
      return (await Links.find(person))
        ? linked()
        : { state: ComposioLinkState.Expired };
    case SignInState.Linked:
      break;
  }
  const { key, account } = signIn.value;
  await Links.removeRequest(person);
  const failed = new PublicError(
    "COMPOSIO_LINK_FAILED",
    "Composio approved the sign-in, but the link could not be finished. Start again.",
  );
  const organization = await client.readOrganization(key);
  if (!organization.ok) throw failed;
  const consumer = await client.resolveConsumer(key, organization.value);
  if (!consumer.ok) throw failed;
  await sealing(() =>
    Links.store(
      {
        ...person,
        key,
        accountLabel: account,
        composioOrgId: organization.value,
        composioProjectId: consumer.value.projectId,
        composioUserId: consumer.value.userId,
      },
      env as never,
    ),
  );
  logEvent("composio.linked", { org: org.orgId, user_id: org.userId });
  return linked();
}

/**
 * The person's link: whether the organization turned Composio on, whether
 * they linked, and the account. With `list`, what is in their Composio
 * that EveryApp supports, read from Composio now; nothing of it is
 * stored.
 */
export async function composioStatus(
  org: OrgContext,
  options: { list?: boolean } = {},
  fetchUpstream: Fetch = send,
): Promise<ComposioStatus> {
  const person = personOf(org);
  const composio = (await OrgSettingsRepository.isComposioOn(org.orgId))
    ? ("on" as const)
    : ("off" as const);
  if (!options.list) {
    const link = await Links.find(person);
    return {
      composio,
      linked: link !== null,
      account: link?.accountLabel ?? null,
      providers: null,
    };
  }
  const read = await composioAccounts(person, fetchUpstream);
  if (!read.linked) {
    return { composio, linked: false, account: null, providers: null };
  }
  const { link, accounts } = read;
  if (accounts === null) {
    return {
      composio,
      linked: true,
      account: link.accountLabel,
      providers: null,
    };
  }
  const registry = await gatewayProviders();
  const mine = await Connections.listComposio(org.orgId, org.userId);
  const providers: ComposioProviderFound[] = [];
  for (const providerId of composioProviderIds()) {
    const services = composioServicesOf(providerId).flatMap(
      ({ slug, label }) => {
        const names = accounts
          .filter((each) => each.slug === slug)
          .map((each) => each.account);
        return names.length > 0 ? [{ slug, label, accounts: names }] : [];
      },
    );
    if (services.length === 0) continue;
    providers.push({
      providerId,
      providerName: providerName(registry, providerId),
      services,
      connected: mine.some((each) => each.providerId === providerId),
    });
  }
  return { composio, linked: true, account: link.accountLabel, providers };
}

/**
 * Unlink: the key, any sign-in waiting, and every connection the person
 * made through it, with its access. The key stays valid at Composio until
 * the person revokes it there.
 */
export async function unlinkComposio(
  org: OrgContext,
): Promise<{ removed: boolean }> {
  const { removed } = await dropComposioLink(
    personOf(org),
    ComposioUnlinkReason.Person,
  );
  return { removed };
}
