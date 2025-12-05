import { env } from "cloudflare:workers";

function validateImageKey(key: string, userId: string): boolean {
  const keyParts = key.split("/");
  if (keyParts.length < 3) return false;

  const keyUserId = keyParts[0];
  return keyUserId === userId;
}

async function r2ToDataUrl(
  r2Key: string,
  contentType: string,
  userId: string,
): Promise<string> {
  // Validate that the user owns this image before fetching
  if (!validateImageKey(r2Key, userId)) {
    throw new Error(`Unauthorized access to image: ${r2Key}`);
  }

  const object = await env.R2.get(r2Key);
  if (!object) {
    throw new Error(`Image not found in R2: ${r2Key}`);
  }

  const arrayBuffer = await object.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");

  return `data:${contentType};base64,${base64}`;
}

export const R2Utils = {
  r2ToDataUrl,
  validateImageKey,
} as const;
