export interface DeployCommandFlags {
  repo?: string;
  verbose?: boolean;
  localGateway?: string;
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
