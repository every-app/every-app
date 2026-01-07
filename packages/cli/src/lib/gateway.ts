/**
 * Check if the gateway has an owner account by querying the hasOwner endpoint
 */
export async function checkGatewayHasOwner(
  gatewayUrl: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${gatewayUrl}/api/admin/has-owner`);
    if (!response.ok) {
      // If endpoint doesn't exist or errors, assume no owner
      return false;
    }
    const data = (await response.json()) as { hasOwner: boolean };
    return data.hasOwner;
  } catch {
    // Network error or other issue - assume no owner
    return false;
  }
}
