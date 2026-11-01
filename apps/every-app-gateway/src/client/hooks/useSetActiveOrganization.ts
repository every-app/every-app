import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/client/auth-client";
import {
  forgetEverythingButAuth,
  refetchCollectionsAfterAuth,
} from "@/client/tanstack-db";

/**
 * Switches the session to another organization: forgets everything cached
 * for the one left, reloads the session and every organization-scoped
 * collection, then opens the home page. The returned function resolves to an
 * error message, or null when the switch worked.
 */
export function useSetActiveOrganization() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return async (organizationId: string): Promise<string | null> => {
    try {
      const result = await authClient.organization.setActive({
        organizationId,
      });
      if (result.error) {
        return result.error.message ?? "Failed to switch organization.";
      }
      // Every cached answer but the sign-in state is the old organization's:
      // the pages show skeletons until the new one's arrive, never its rows.
      forgetEverythingButAuth(queryClient);
      await queryClient.refetchQueries({ queryKey: ["auth", "session"] });
      await refetchCollectionsAfterAuth();
      await navigate({ to: "/" });
      return null;
    } catch (err) {
      return err instanceof Error
        ? err.message
        : "Failed to switch organization.";
    }
  };
}
