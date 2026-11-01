/** Immutable public conversions; arbitrary hosts/redirects are not an install source. */
export const OSS_NEW_RELEASE_URL = /^https:\/\/oss\.new\/apps\/[a-f0-9]{64}$/;

export function isAppInstallUrl(value: string): boolean {
  return (
    OSS_NEW_RELEASE_URL.test(value) ||
    /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}\/?$)[A-Za-z0-9._-]{1,100}\/?$/.test(
      value,
    )
  );
}
