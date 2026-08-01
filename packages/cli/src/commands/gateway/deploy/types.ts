export interface DeployCommandFlags {
  verbose?: boolean;
  localGateway?: string;
  domain?: string;
  yes?: boolean;
}

export interface CloudflareResources {
  d1DatabaseId: string;
  kvNamespaceIds: Record<string, string>;
  accountId: string;
}

export interface JwtKeyPair {
  privateKey: string;
  publicKey: string;
}
