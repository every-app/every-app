interface FormatWildcardDnsInstructionsOptions {
  domain: string;
  accountId: string | null;
  mode: "gateway-warning" | "app-blocking";
  hostname?: string;
}

export function formatWildcardDnsInstructions({
  domain,
  accountId,
  mode,
  hostname,
}: FormatWildcardDnsInstructionsOptions): string {
  const dashboardTarget = accountId
    ? `https://dash.cloudflare.com/${accountId}/${domain}/dns/records`
    : `https://dash.cloudflare.com -> ${domain} -> DNS`;
  const exampleHost = hostname ?? `todo.${domain}`;
  const intro =
    mode === "app-blocking"
      ? [
          `Each app you deploy will live at [app].${domain} - this app at`,
          `${exampleHost} - but that address does not resolve yet. To support`,
          `this, you must add the DNS record below:`,
        ]
      : [
          `Each app you deploy will live at [app].${domain} - for example`,
          `todo.${domain}. To support this, you must add the DNS record`,
          `below (the login this CLI uses isn't allowed to add it for you):`,
        ];
  const outro =
    mode === "app-blocking"
      ? [
          `After DNS propagates, re-run everyapp app deploy.`,
          `If you know DNS is ready and this check is blocked locally, re-run with --skip-dns-check.`,
        ]
      : [
          `Continuing the deploy - once you add that record, apps at`,
          `*.${domain} will work properly. You only do this once.`,
        ];

  return [
    ``,
    ...intro,
    ``,
    `  Add record at: ${dashboardTarget}`,
    `    Type:    CNAME`,
    `    Name:    *`,
    `    Target:  ${domain}`,
    `    Proxy:   ON (orange cloud)`,
    ``,
    `Here are the docs explaining how this works:`,
    `  https://developers.cloudflare.com/workers/configuration/routing/routes/`,
    `  https://github.com/cloudflare/workers-sdk/issues/5568`,
    ``,
    ...outro,
    ``,
  ].join("\n");
}
