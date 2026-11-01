/**
 * Commerce and business data: payments, stores, banking, CRMs, tables and docs.
 *
 * Catalog entries written from each provider's own documentation on
 * 2026-10-25 by one research agent per batch and checked by a second
 * (docs/design/2026-10-provider-registry.md, section 9); an entry the
 * checker could not confirm says `verified: false` and why. Each is the
 * JSON `everyapp provider add` takes, as a literal, so the ids and setting
 * names stay types (`CapabilityId`, `CapabilitySecret`).
 */
import type { ApiKeyCapability } from "../capabilities.js";

export const COMMERCE = {
  stripe: {
    mode: "api_key",
    label: "Stripe",
    description:
      "Payments: customers, subscriptions, invoices, charges and payouts.",
    auth: {
      kind: "bearer",
      secret: "STRIPE_API_KEY",
    },
    docs: "https://dashboard.stripe.com/apikeys",
    api: "https://docs.stripe.com/api",
    hosts: ["api.stripe.com", "files.stripe.com"],
    data: "account",
    access: ["read", "write"],
    readMethods: ["GET", "HEAD"],
    writeMethods: ["POST", "DELETE"],
    accountWidePaths: [
      ["v1", "account"],
      ["v1", "accounts"],
      ["v2", "core", "accounts"],
      ["v1", "webhook_endpoints"],
      ["v2", "core", "event_destinations"],
      ["v1", "apps", "secrets"],
    ],
    hint: "A restricted API key from the API keys page of the Stripe dashboard, with only the permissions the app needs. The Gateway sends it as a bearer token.",
    secrets: [
      {
        name: "STRIPE_API_KEY",
        hint: "A restricted key (rk_live_...) with only the permissions the app needs; a sandbox key (rk_test_... or sk_test_...) to try it.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/v1/balance",
      expect: [200],
      free: true,
      note: "A restricted key needs Balance read for this one.",
    },
    cost: {
      unit: "call",
      note: "No per-call price; reads should average under 500 per transaction over 30 days, with at least 10,000 a month allowed.",
    },
    rate: {
      perSecond: 100,
      note: "Live mode, per account; sandbox 25/s; most single endpoints 25/s; Search 20/s.",
    },
    example: "list my latest customers and their subscriptions",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["payments", "billing"],
  },
  lemonsqueezy: {
    mode: "api_key",
    label: "Lemon Squeezy",
    description:
      "Merchant of record for software: stores, products, orders, subscriptions, license keys.",
    auth: {
      kind: "bearer",
      secret: "LEMONSQUEEZY_API_KEY",
    },
    docs: "https://app.lemonsqueezy.com/settings/api",
    api: "https://docs.lemonsqueezy.com/api",
    hosts: ["api.lemonsqueezy.com"],
    data: "account",
    access: ["read", "write"],
    readMethods: ["GET", "HEAD"],
    writeMethods: ["POST", "PATCH", "DELETE"],
    accountWidePaths: [
      ["v1", "users"],
      ["v1", "webhooks"],
    ],
    hint: "An API key from Settings > API in Lemon Squeezy; the Gateway sends it as a bearer token. The API is JSON:API, so the app sends Accept and Content-Type application/vnd.api+json.",
    secrets: [
      {
        name: "LEMONSQUEEZY_API_KEY",
        hint: "An API key from Settings > API; a test mode key reaches test mode store data only.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/v1/users/me",
      expect: [200],
      free: true,
      note: "Account-wide, so the Gateway refuses it for apps; run it from the person's terminal.",
    },
    rate: {
      perMinute: 300,
      note: "300 API calls per minute.",
    },
    example: "list this month's orders and active subscriptions",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["payments", "billing"],
  },
  paddle: {
    mode: "api_key",
    label: "Paddle",
    description:
      "Paddle Billing: products, prices, customers, subscriptions and transactions.",
    auth: {
      kind: "bearer",
      secret: "PADDLE_API_KEY",
    },
    docs: "https://developer.paddle.com/api-reference/about/authentication/",
    api: "https://developer.paddle.com/api-reference/",
    hosts: ["api.paddle.com", "sandbox-api.paddle.com"],
    data: "account",
    access: ["read", "write"],
    readMethods: ["GET", "HEAD"],
    writeMethods: ["POST", "PATCH", "DELETE"],
    accountWidePaths: [
      ["account"],
      ["settings"],
      ["notification-settings"],
      ["notifications"],
      ["simulations"],
      ["simulation-runs"],
      ["client-tokens"],
      ["checkout-domains"],
      ["verifications"],
    ],
    hint: "An API key from Paddle > My account > Settings > Authentication (API keys tab), with only the permissions the app needs; the Gateway sends it as a bearer token. Live and sandbox are separate hosts with separate keys.",
    secrets: [
      {
        name: "PADDLE_API_KEY",
        hint: "An API key (pdl_live_apikey_... or pdl_sdbx_apikey_...) with only the permissions the app needs; a sandbox key works on the sandbox host only.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/event-types",
      expect: [200],
      free: true,
      note: "Paddle's own first request: needs no permissions. Send it to sandbox-api.paddle.com with a sandbox key.",
    },
    rate: {
      perMinute: 240,
      note: "Per IP address; pricing previews 1,000 a minute; 20 immediate-charge updates per subscription an hour.",
    },
    example: "list the active subscriptions that renew this week",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["payments", "billing"],
  },
  // Legacy admin custom apps only: Shopify no longer lets a store create one, and Dev Dashboard tokens expire daily (the hint says so; shipping it is Ben's call, TODO.md).
  shopify: {
    mode: "api_key",
    label: "Shopify",
    description:
      "One store's Admin API (GraphQL): products, orders, customers and inventory.",
    auth: {
      kind: "header",
      secret: "SHOPIFY_API_TOKEN",
      header: "X-Shopify-Access-Token",
    },
    docs: "https://shopify.dev/docs/apps/build/authentication-authorization/legacy/admin-custom-apps",
    api: "https://shopify.dev/docs/api/admin-graphql",
    hosts: [],
    hostSetting: "SHOPIFY_HOST",
    data: "account",
    access: ["write"],
    readMethods: [],
    writeMethods: ["POST"],
    accountWidePaths: [["webhooks"], ["storefront_access_tokens"]],
    hint: "An Admin API access token from a custom app created in the store's admin, sent in the X-Shopify-Access-Token header to the store's myshopify.com host. Shopify no longer lets stores create new admin custom apps, and Dev Dashboard tokens expire after 24 hours, which the Gateway can't refresh yet.",
    secrets: [
      {
        name: "SHOPIFY_API_TOKEN",
        hint: "The Admin API access token of a custom app made in the store's admin (Apps > Develop apps > the app > API credentials); it is shown once.",
      },
      {
        name: "SHOPIFY_HOST",
        hint: "The store's own host, like your-store.myshopify.com.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/admin/api/2026-10/shop.json",
      expect: [200],
      free: true,
      note: "The legacy REST read of the store; the Gateway forwards no GET for this entry, so run it from the person's terminal.",
    },
    rate: {
      note: "GraphQL cost points per second by plan: Standard 100, Advanced 200, Plus 1,000, enterprise 2,000.",
    },
    example: "list the ten newest orders and what was in them",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["ecommerce"],
  },
  // Unverified: Plaid wants a client id and a secret on every call (body or two headers); one header is all this kind sends, so the app adds PLAID-CLIENT-ID itself.
  plaid: {
    mode: "api_key",
    label: "Plaid",
    description:
      "Bank data: accounts, balances, transactions and identity, for the Items an app links.",
    auth: {
      kind: "header",
      secret: "PLAID_SECRET",
      header: "PLAID-SECRET",
    },
    docs: "https://dashboard.plaid.com/developers/keys",
    api: "https://plaid.com/docs/api/",
    hosts: ["sandbox.plaid.com", "production.plaid.com"],
    data: "account",
    access: ["read"],
    readMethods: ["POST"],
    accountWidePaths: [
      ["item", "webhook", "update"],
      ["item", "access_token", "invalidate"],
      ["item", "remove"],
      ["webhook_verification_key"],
      ["dashboard_user"],
      ["transfer"],
      ["payment_initiation"],
    ],
    hint: "Plaid needs a client_id and a secret on every call, in the JSON body or in the PLAID-CLIENT-ID and PLAID-SECRET headers. The Gateway puts on one header, so the app would have to send PLAID-CLIENT-ID itself. Every endpoint is a POST.",
    secrets: [
      {
        name: "PLAID_SECRET",
        hint: "The secret for one environment (Sandbox or Production) from the Keys page of the Plaid Dashboard.",
      },
    ],
    rate: {
      note: "Set per endpoint and per Item: /accounts/get allows 15 a minute per Item and 15,000 a minute per client.",
    },
    example: "list the last 30 days of transactions on a linked account",
    verified: false,
    tags: ["finance", "banking"],
  },
  attio: {
    mode: "api_key",
    label: "Attio",
    description:
      "CRM: people, companies, deals, lists, notes and tasks in one Attio workspace.",
    auth: {
      kind: "bearer",
      secret: "ATTIO_API_KEY",
    },
    docs: "https://attio.com/help/reference/apps/generating-an-api-key",
    api: "https://docs.attio.com/rest-api/overview",
    hosts: ["api.attio.com"],
    data: "account",
    access: ["read", "write"],
    readMethods: ["GET", "HEAD"],
    writeMethods: ["POST", "PUT", "PATCH", "DELETE"],
    accountWidePaths: [
      ["v2", "self"],
      ["v2", "webhooks"],
      ["v2", "workspace_members"],
    ],
    hint: "An access token a workspace admin makes under Workspace settings > Developers, scoped to what the app needs; the Gateway sends it as a bearer token. Listing and searching records are POSTs, so an app that lists records needs write access.",
    secrets: [
      {
        name: "ATTIO_API_KEY",
        hint: "An access token from Workspace settings > Developers, with only the scopes the app needs.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/v2/objects",
      expect: [200],
      free: true,
      note: "Lists the workspace's objects; needs the object_configuration:read scope. /v2/self answers 200 even for a revoked token.",
    },
    rate: {
      perSecond: 100,
      note: "100 reads and 25 writes per second; listing records and entries also has score-based limits.",
    },
    example: "find the companies we added this week and their open deals",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["crm"],
  },
  hubspot: {
    mode: "api_key",
    label: "HubSpot",
    description:
      "CRM and marketing: contacts, companies, deals, tickets and more in one HubSpot account.",
    auth: {
      kind: "bearer",
      secret: "HUBSPOT_API_TOKEN",
    },
    docs: "https://developers.hubspot.com/docs/apps/legacy-apps/private-apps/overview",
    api: "https://developers.hubspot.com/docs/api-reference/latest/overview",
    hosts: ["api.hubapi.com"],
    data: "account",
    access: ["read", "write"],
    readMethods: ["GET", "HEAD"],
    writeMethods: ["POST", "PUT", "PATCH", "DELETE"],
    accountWidePaths: [
      ["account-info"],
      ["settings", "users"],
      ["settings", "v3", "users"],
      ["settings", "teams"],
      ["app-webhooks"],
      ["webhooks"],
      ["webhooks-journal"],
      ["oauth"],
    ],
    hint: "An access token from a HubSpot legacy private app (Development > Legacy apps > Create legacy app > Private), scoped to what the app needs; the Gateway sends it as a bearer token. CRM search is a POST, so an app that searches needs write access.",
    secrets: [
      {
        name: "HUBSPOT_API_TOKEN",
        hint: "The access token of a legacy private app (Development > Legacy apps > the app > Auth), with only the scopes the app needs.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/account-info/2026-09/details",
      expect: [200],
      free: true,
      note: "Account-wide, so the Gateway refuses it for apps; run it from the person's terminal.",
    },
    rate: {
      perDay: 250000,
      note: "Private apps on Free and Starter: 100 per 10 seconds per app and 250,000 a day per account; Pro 190 and 625,000; Enterprise 190 and 1,000,000.",
    },
    example: "list the deals that moved to closed won this month",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["crm", "marketing"],
  },
  pipedrive: {
    mode: "api_key",
    label: "Pipedrive",
    description:
      "Sales CRM: deals, persons, organizations, activities and pipelines.",
    auth: {
      kind: "header",
      secret: "PIPEDRIVE_API_TOKEN",
      header: "x-api-token",
    },
    docs: "https://app.pipedrive.com/settings/api",
    api: "https://developers.pipedrive.com/docs/api/v1",
    hosts: ["api.pipedrive.com"],
    data: "account",
    access: ["read", "write"],
    readMethods: ["GET", "HEAD"],
    writeMethods: ["POST", "PUT", "PATCH", "DELETE"],
    accountWidePaths: [
      ["v1", "users"],
      ["v1", "webhooks"],
      ["v1", "billing"],
      ["v1", "permissionsets"],
      ["v1", "roles"],
      ["v1", "usersettings"],
      ["v1", "userconnections"],
      ["v1", "legacyteams"],
    ],
    hint: "A personal API token from Settings > Personal preferences > API in Pipedrive; the Gateway sends it in the x-api-token header. If API is missing there, an admin enables it for the person's permission set.",
    secrets: [
      {
        name: "PIPEDRIVE_API_TOKEN",
        hint: "Your personal API token from Settings > Personal preferences > API; it acts as you, and each company you belong to has its own.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/v1/users/me",
      expect: [200],
      free: true,
      note: "Account-wide, so the Gateway refuses it for apps; run it from the person's terminal.",
    },
    cost: {
      unit: "call",
      note: "Each endpoint spends API tokens from a daily company budget of 30,000 x plan multiplier (1 to 7) x seats.",
    },
    rate: {
      note: "Per API token: 20 (Lite) to 120 (Ultimate) requests per 2 seconds; Search 10 per 2 seconds.",
    },
    example: "list the open deals in my main pipeline",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["crm", "sales"],
  },
  airtable: {
    mode: "api_key",
    label: "Airtable",
    description:
      "Bases, tables and records in the Airtable workspaces a token can reach.",
    auth: {
      kind: "bearer",
      secret: "AIRTABLE_API_TOKEN",
    },
    docs: "https://airtable.com/create/tokens",
    api: "https://airtable.com/developers/web/api/introduction",
    hosts: ["api.airtable.com"],
    data: "account",
    access: ["read", "write"],
    readMethods: ["GET", "HEAD"],
    writeMethods: ["POST", "PUT", "PATCH", "DELETE"],
    accountWidePaths: [
      ["v0", "meta", "whoami"],
      ["v0", "meta", "enterpriseaccounts"],
      ["v0", "meta", "workspaces"],
      ["v0", "meta", "groups"],
      ["v0", "bases"],
      ["scim"],
      ["collaborators"],
      ["invites"],
      ["shares"],
      ["blockinstallations"],
    ],
    hint: "A personal access token from airtable.com/create/tokens, limited to the scopes and bases the app needs; the Gateway sends it as a bearer token. Listing records by POST (listRecords) needs write access; the GET form doesn't.",
    secrets: [
      {
        name: "AIRTABLE_API_TOKEN",
        hint: "A personal access token limited to the scopes and bases the app needs.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/v0/meta/whoami",
      expect: [200],
      free: true,
      note: "Account-wide, so the Gateway refuses it for apps; run it from the person's terminal.",
    },
    rate: {
      perSecond: 5,
      note: "5 requests per second per base; 50 per second across all of one user's personal access tokens.",
    },
    example: "list this week's new rows in my Leads table",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["database", "spreadsheet"],
  },
  notion: {
    mode: "api_key",
    label: "Notion",
    description:
      "Pages, databases and blocks that a Notion connection has been given.",
    auth: {
      kind: "bearer",
      secret: "NOTION_API_TOKEN",
    },
    docs: "https://app.notion.com/developers/connections",
    api: "https://developers.notion.com/reference/intro",
    hosts: ["api.notion.com"],
    data: "account",
    access: ["read", "write"],
    readMethods: ["GET", "HEAD"],
    writeMethods: ["POST", "PATCH", "DELETE"],
    accountWidePaths: [["v1", "users"], ["v1", "oauth"], ["admin"]],
    hint: "An internal connection's API token (a workspace owner creates the connection in Notion's developer portal), sent as a bearer token; it reaches only pages shared with it. The app sends the Notion-Version header itself. Search and data source queries are POSTs, so an app that queries needs write access.",
    secrets: [
      {
        name: "NOTION_API_TOKEN",
        hint: "The API token on an internal connection's Configuration tab; share the pages it should reach with the connection.",
      },
    ],
    smoke: {
      method: "GET",
      path: "/v1/users/me",
      expect: [200],
      free: true,
      note: "Send Notion-Version: 2026-03-11 with it; account-wide, so run it from the person's terminal.",
    },
    rate: {
      perMinute: 180,
      note: "Per connection: 180 a minute, 600 on Business and Enterprise; data source queries about 3 per second.",
    },
    example: "find the pages in my Projects database that are due this week",
    verified: {
      on: "2026-10-25",
      how: "docs",
    },
    tags: ["docs", "notes", "database"],
  },
} as const satisfies Record<string, ApiKeyCapability>;
