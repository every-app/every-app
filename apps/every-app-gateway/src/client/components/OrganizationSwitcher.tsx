import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Building2, Check, ChevronsUpDown } from "lucide-react";
import { toast } from "sonner";
import { authClient } from "@/client/auth-client";
import { useActiveOrganization } from "@/client/hooks/useActiveOrganization";
import { useSetActiveOrganization } from "@/client/hooks/useSetActiveOrganization";
import { Skeleton } from "@/client/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/client/components/ui/dropdown-menu";

/**
 * The active organization at the top of the sidebar, with a menu that
 * switches to another of the user's organizations. It is 40px tall, like the
 * page's search box beside it, and its 11px inset plus the 1px border puts
 * the name in line with the logo.
 */
export function OrganizationSwitcher({
  signedIn,
  onCloseDrawer,
}: {
  /** The session is confirmed, so the active organization can load. */
  signedIn: boolean;
  onCloseDrawer?: () => void;
}) {
  const { data: organizations } = authClient.useListOrganizations();
  const { data: activeOrganization, isPending } = useActiveOrganization({
    enabled: signedIn,
  });
  const setActiveOrganization = useSetActiveOrganization();
  const [isSwitching, setIsSwitching] = useState(false);

  if (isPending) {
    // The loaded switcher's row, so nothing moves when the organization
    // arrives.
    return (
      <div
        className="flex h-10 items-center rounded-lg border border-sidebar-border/70 bg-card px-[11px]"
        aria-busy
      >
        <Skeleton className="h-3.5 w-28" />
      </div>
    );
  }

  const handleSelect = async (organizationId: string) => {
    onCloseDrawer?.();
    if (isSwitching || organizationId === activeOrganization?.id) return;
    setIsSwitching(true);
    const error = await setActiveOrganization(organizationId);
    setIsSwitching(false);
    if (error) toast.error(error);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Switch organization"
        disabled={isSwitching}
        className="flex h-10 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-sidebar-border/70 bg-card px-[11px] text-left shadow-xs outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
      >
        <span className="truncate text-sm font-medium">
          {activeOrganization?.name ?? "Select organization"}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-(--anchor-width)">
        {organizations && organizations.length > 0 ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Organizations</DropdownMenuLabel>
              {organizations.map((organization) => (
                <DropdownMenuItem
                  key={organization.id}
                  disabled={isSwitching}
                  onClick={() => void handleSelect(organization.id)}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{organization.name}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {organization.slug}
                    </span>
                  </span>
                  {organization.id === activeOrganization?.id ? (
                    <Check className="ml-auto" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem
          render={<Link to="/organizations" onClick={onCloseDrawer} />}
        >
          <Building2 />
          Manage organizations
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
