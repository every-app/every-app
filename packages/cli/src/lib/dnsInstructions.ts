interface FormatWildcardDnsInstructionsOptions {
  domain: string;
  accountId: string | null;
  mode: "gateway-warning" | "app";
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
  const exampleHost = hostname ?? `todo-acme.${domain}`;
  const intro =
    mode === "app"
      ? [
          `Each app you deploy lives at [app]-[org].${domain} - this app at`,
          `${exampleHost} - but that address does not resolve yet. To support`,
          `this, you must add the DNS record below:`,
        ]
      : [
          `Each app you deploy will live at [app]-[org].${domain} - for`,
          `example ${exampleHost}. To support this, you must add the DNS`,
          `record below:`,
        ];
  const outro =
    mode === "app"
      ? [
          `The app is deployed; it answers at ${exampleHost} once DNS`,
          `propagates. You only add this record once.`,
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
