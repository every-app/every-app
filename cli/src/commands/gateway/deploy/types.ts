export interface DeployCommandFlags {
  repo?: string;
  verbose?: boolean;
}

export interface CloudflareResources {
  d1DatabaseId: string;
  kvNamespaceId: string;
  accountId?: string;
}

export interface JwtKeyPair {
  privateKey: string;
  publicKey: string;
}

export interface SecretInfo {
  name: string;
  type: string;
}
