import { describe, expect, it } from "vitest";
import { formatWildcardDnsInstructions } from "./dnsInstructions";

describe("formatWildcardDnsInstructions", () => {
  it("formats the gateway warning with the shared wildcard DNS record block", () => {
    expect(
      formatWildcardDnsInstructions({
        domain: "example.com",
        accountId: "acct-1",
        mode: "gateway-warning",
      }),
    ).toContain(
      "Add record at: https://dash.cloudflare.com/acct-1/example.com/dns/records",
    );
  });

  it("formats the app blocking variant with hostname context", () => {
    const instructions = formatWildcardDnsInstructions({
      domain: "example.com",
      accountId: null,
      mode: "app-blocking",
      hostname: "todo.example.com",
    });

    expect(instructions).toContain("todo.example.com");
    expect(instructions).toContain("re-run everyapp app deploy");
  });
});
