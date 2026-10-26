/**
 * The well-known keypair and issuer of local dev identities.
 *
 * Public by design: the private key is in this file for anyone to read, so a
 * token signed with it proves nothing outside dev. The SDK accepts it only
 * under the dev key id, only behind the dev opt-in (`EVERYAPP_DEV`, which
 * `everyAppWorker()` sets in development and a deploy never does), and only
 * from {@link DEV_ISSUER}. Anything that reaches the local dev ports can mint
 * a dev identity with it; that is the local-dev trust boundary, which is why
 * `everyapp dev` listens on 127.0.0.1 unless told otherwise.
 *
 * A leaf module: `cloudflare.config.ts` loads it through
 * `@every-app/sdk/cloudflare`, and the Vite plugin hides from the Worker
 * every file the config loads, so the Worker never imports it. The Worker
 * side keeps its own copy of the issuer (`internal/protocol.ts`); a test
 * pins the two together.
 */

/** Issuer of locally minted dev identity tokens. */
export const DEV_ISSUER = "https://gateway.dev.localhost";
/** The organization the dev gateway's seeded user belongs to (`everyAppWorker()` sets it as `EVERY_APP_ORG_ID` in dev). */
export const DEV_ORG_ID = "dev-org";

/** SPKI PEM public half of the dev keypair. */
export const DEV_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAh40zWf+QK3rJdMTNoy+X
F9iydV5raWSeEt4DXyeY98c8IZHRjy2UXaaYejweebRsv9Az+bZuL3cfJ0E7pOGd
4VCOiSG1BjJglmTC1whV4Md6qhLDVOP6iztUJSxDwnlR85UtOyNJ4G5dYY6RrAWl
PMMXPSYdGWqAP4n5QXAw+7uTFmJMdWy1W8KLbTj//NSGn3DCm+EZJIC8q9yDhMSc
M0ejJnBVColvp4T8k8dt2kYGu2Wd7dCMrHv/lxUoqD58avpdMOzbaZtwsQ7BAaIa
mIeQ1AKxmnCj1np23uWvYQmoaZocvupLSALK7fWGUyVDZ+RW4HtN5KqzZypfiyZ8
kQIDAQAB
-----END PUBLIC KEY-----
`;

/** PKCS#8 PEM private half of the dev keypair. Public, see above. */
export const DEV_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCHjTNZ/5Aresl0
xM2jL5cX2LJ1XmtpZJ4S3gNfJ5j3xzwhkdGPLZRdpph6PB55tGy/0DP5tm4vdx8n
QTuk4Z3hUI6JIbUGMmCWZMLXCFXgx3qqEsNU4/qLO1QlLEPCeVHzlS07I0ngbl1h
jpGsBaU8wxc9Jh0ZaoA/iflBcDD7u5MWYkx1bLVbwottOP/81IafcMKb4RkkgLyr
3IOExJwzR6MmcFUKiW+nhPyTx23aRga7ZZ3t0Iyse/+XFSioPnxq+l0w7Ntpm3Cx
DsEBohqYh5DUArGacKPWenbe5a9hCahpmhy+6ktIAsrt9YZTJUNn5Fbge03kqrNn
Kl+LJnyRAgMBAAECggEABCi9GAB3URw3APgWarDHwS2vGRqU72KM1p2dCx8FCqpA
cjO+Ezd171Mwp8R/N2MFuLN32sxCEH8GU88kuDwLevm8q+C+xBJI5ChykYRCFU/t
l7kUaP8HRZ0kCXF0oUuVbATKYt+D8WjVgOwt1FJGhgki5geMukZKKdjvDtbVS+4D
qGRBV4/XT4Y5JDNrjnITwSV2xfMD6Yd92/NN375+V9vWFI4kaESPbE/YQ7yF1o66
DfhjRMSMmTgWEeoVDwFMlnXppo1nkdEXY8MXlgho0mDGre4PurAvQmZRYlU6VJ63
x7/NTaNPnQEJ7+FkUXvtOz8sCBjLzgtilGnBNwGqeQKBgQC7zA7kojSPYvlm7nbC
L2kO8iAL3p/B1vtS6XLTFiV0Wv2kT6Cy51ulVteUijwGMrDuCMdBqXfIocQvYhls
JzPR/DaFcE2qClCei9L4wxvdBLcqoQH7LsllGA9oHSoZNnzT0muNech0xuL75X6B
LLMpVtOyb/prd8N6hhBlcGElCQKBgQC4x8A9aDnFlcyztcutW2YQMfEyDEK+PcuC
n6cnSJ8MjmFEyulKZuklqKkhwMiNBm8xNhI6UdUtrFPfKmGqYifjEUX4D6xGLL8b
LNOZojkMAI3jtuD+IGzlpkSCy2TWXVb53TTi82LUD7Sbb5siYhL5uW0IRzbJt1aR
n2JNphvFSQKBgA1NPNjQ7GwjlIrH5T2H4ice20o78JDoS1DqHCn7bZe6QjD7OuSx
Inqplgd9axb9TC7wDD0IZeWeH6lDh41zkWYUOUBmXfnnVSKFwOHB4B1dkiPA18UU
4Ur5002Kk0rJ4zmVs+yHbb1nwPgan0VDB0WsUr5W1CP8jaoGCO9GcHsRAoGAX6Xm
eOLupLx6DbxZBg99sXxoocN++QL7yU3jNI5+5fz9lKKESCMlJH09r18fcQCXph2b
Kd0aQF4nvCkwDQZqJzvVwCY8wsZ+1g5KKgizBudyiyErLeCS/f0nEZ0/QUdnskcz
DRd3XNYUYzFOWGnz8JhvPA3A6oGgqhiaxh7p2SECgYA+7s6WRfQLSad3dXuDNajQ
sBwG4E6M/yUbgdbNjnv+AuVYS8Uyvf6x/xaWH3zssluIXhod0Two22bjtkPGJ2nx
1ZXmbxSdWVGwLZn3GYRoRu6X6VGTbFAaK1mb7KDfwjoaauV7G3A2mw6M5xxg4zx/
hsbx0DA4sMMIUEniw9W/YA==
-----END PRIVATE KEY-----
`;
