import enquirer from "enquirer";

interface GatewayOrganization {
  id: string;
  name: string;
  slug: string;
}

interface GatewayOrganizationsResponse {
  organizations?: GatewayOrganization[];
}

async function listOrganizationsFromGateway(options: {
  gatewayUrl: string;
  cloudflareToken: string;
  verbose?: boolean;
}): Promise<GatewayOrganization[] | null> {
  // Operator-plane API trust boundary: docs/security-model.md
  const response = await fetch(
    `${options.gatewayUrl}/api/internal/apps/organizations`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${options.cloudflareToken}`,
      },
    },
  );

  if (!response.ok) {
    if (options.verbose) {
      console.log(
        `Could not load organizations from gateway (${response.status}). Falling back to manual organization ID input.`,
      );
    }
    return null;
  }

  const payload = (await response.json()) as GatewayOrganizationsResponse;
  if (!Array.isArray(payload.organizations)) {
    return null;
  }

  return payload.organizations;
}

export async function resolveOrganizationIdForGateway(options: {
  organizationId?: string;
  verbose?: boolean;
  gatewayUrl?: string;
  cloudflareToken?: string;
}): Promise<string> {
  const explicitOrganizationId = options.organizationId?.trim();
  if (explicitOrganizationId) {
    return explicitOrganizationId;
  }

  const envOrganizationId = process.env["EVERY_APP_ORG_ID"]?.trim();
  if (envOrganizationId) {
    if (options.verbose) {
      console.log(`Using EVERY_APP_ORG_ID=${envOrganizationId}.`);
    }
    return envOrganizationId;
  }

  if (options.gatewayUrl && options.cloudflareToken) {
    const organizations = await listOrganizationsFromGateway({
      gatewayUrl: options.gatewayUrl,
      cloudflareToken: options.cloudflareToken,
      verbose: options.verbose,
    });

    if (organizations?.length === 1) {
      const organization = organizations[0];
      if (!organization) {
        throw new Error("Failed to resolve organization from gateway response");
      }
      if (options.verbose) {
        console.log(
          `Using the only organization in gateway: ${organization.name} (${organization.id}).`,
        );
      }
      return organization.id;
    }

    if (organizations && organizations.length > 1) {
      const { organizationId } = await enquirer.prompt<{
        organizationId: string;
      }>({
        type: "select",
        name: "organizationId",
        message: "Select the target organization",
        choices: organizations.map((organization) => ({
          name: organization.id,
          message: `${organization.name} (${organization.slug})`,
        })),
      });

      return organizationId;
    }
  }

  const { organizationId } = await enquirer.prompt<{ organizationId: string }>({
    type: "input",
    name: "organizationId",
    message: "Enter the target organization ID",
    validate: (value: string) => {
      if (!value.trim()) {
        return "Organization ID is required";
      }

      return true;
    },
  });

  return organizationId.trim();
}
