## events

{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.connect","status":"start","message":"Finding your Gateway..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.connect","status":"ok","data":{"gatewayUrl":"https://example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.deploy","status":"ok","message":"Deploying agentic-inbox to https://example.com.","data":{"appId":"agentic-inbox","organizationName":"Acme","firstDeploy":true,"gatewayUrl":"https://example.com","gatewayHost":"example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.register","status":"ok","message":"Registered agentic-inbox as every-acme-agentic-inbox at https://agentic-inbox.example.com (pending).","data":{"appId":"agentic-inbox","workerName":"every-acme-agentic-inbox","hostname":"agentic-inbox.example.com","status":"pending","existingApp":false,"firstDeploy":true,"defaultAccess":true,"deployerAccess":false,"hasOwner":false,"publicRoutes":[],"mcp":null,"scope":"org","organizationId":"<uuid-1>","organizationName":"Acme","gatewayUrl":"https://example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"warning","code":"CUSTOM_DOMAIN_OWNER_UNCHECKED","step":"app.domain","message":"If another Worker already serves agentic-inbox.example.com, it will be replaced by this deployment.","data":{"hosts":["agentic-inbox.example.com"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.resources","status":"start","message":"Preparing the app's resources..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.resources","status":"ok","message":"The app's resources are ready."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.install","status":"start","message":"Installing dependencies..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.install","status":"ok"}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.build","status":"start","message":"Building..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"progress","step":"app.build","message":"Created R2 bucket \"every-acme-agentic-inbox\".","data":{"bucket":"every-acme-agentic-inbox"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.build","status":"ok","message":"Built the app and checked its Worker.","data":{"release":false,"workflows":[]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.upload","status":"start","message":"Uploading every-acme-agentic-inbox..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.upload","status":"ok","message":"Uploaded version every-acme-agentic-inbox-version-6.","data":{"versionId":"every-acme-agentic-inbox-version-6"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"warning","code":"APP_NEEDS_SETUP","step":"app.secrets","message":"agentic-inbox won't open until WORKERS_AI_API_TOKEN and OPENROUTER_API_KEY are set","data":{"setup":{"ready":false,"settings":[{"kind":"provider","id":"workers-ai","label":"Workers AI","holder":"gateway","names":["WORKERS_AI_API_TOKEN"],"need":{"kind":"required"},"docs":"https://dash.cloudflare.com/profile/api-tokens","setup":"setup/workers-ai.md","hint":"A Cloudflare API token with Workers AI Read (the Workers AI page's prefilled token); the account is the Gateway's own.","set":false,"blocking":true},{"kind":"provider","id":"openrouter","label":"OpenRouter","holder":"gateway","names":["OPENROUTER_API_KEY"],"need":{"kind":"required"},"docs":"https://openrouter.ai/settings/keys","setup":"setup/openrouter.md","hint":"An API key from OpenRouter's keys page; the Gateway puts it on every call as a bearer token.","set":false,"blocking":true}],"unmet":[{"kind":"provider","id":"workers-ai","label":"Workers AI","holder":"gateway","names":["WORKERS_AI_API_TOKEN"],"need":{"kind":"required"},"docs":"https://dash.cloudflare.com/profile/api-tokens","setup":"setup/workers-ai.md","hint":"A Cloudflare API token with Workers AI Read (the Workers AI page's prefilled token); the account is the Gateway's own.","set":false,"blocking":true},{"kind":"provider","id":"openrouter","label":"OpenRouter","holder":"gateway","names":["OPENROUTER_API_KEY"],"need":{"kind":"required"},"docs":"https://openrouter.ai/settings/keys","setup":"setup/openrouter.md","hint":"An API key from OpenRouter's keys page; the Gateway puts it on every call as a bearer token.","set":false,"blocking":true}],"groups":[],"command":{"command":"pnpm everyapp configure agentic-inbox"}}}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.bind","status":"start","message":"Binding APP__every-acme-agentic-inbox on the gateway and publishing its hostname...","data":{"appId":"agentic-inbox"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"gateway.deploy","status":"start","message":"Uploading Gateway 0.2.0 with 1 app","data":{"appWorkers":["every-acme-agentic-inbox"],"domains":["example.com","agentic-inbox.example.com"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"gateway.deploy","status":"ok","message":"Uploaded version every-app-gateway-version-8","data":{"versionId":"every-app-gateway-version-8"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.bind","status":"ok","message":"The gateway binds APP__every-acme-agentic-inbox (gateway version every-app-gateway-version-8).","data":{"versionId":"every-app-gateway-version-8","newHosts":["agentic-inbox.example.com"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.live","status":"ok","message":"agentic-inbox is live at https://agentic-inbox.example.com.","data":{"hostname":"agentic-inbox.example.com","url":"https://agentic-inbox.example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.connect","status":"start","message":"Finding your Gateway..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.connect","status":"ok","data":{"gatewayUrl":"https://example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.deploy","status":"ok","message":"Deploying agentic-inbox to https://example.com.","data":{"appId":"agentic-inbox","organizationName":"Acme","firstDeploy":false,"gatewayUrl":"https://example.com","gatewayHost":"example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.register","status":"ok","message":"Updating agentic-inbox as every-acme-agentic-inbox at https://agentic-inbox.example.com (active).","data":{"appId":"agentic-inbox","workerName":"every-acme-agentic-inbox","hostname":"agentic-inbox.example.com","status":"active","existingApp":true,"firstDeploy":false,"defaultAccess":true,"deployerAccess":false,"hasOwner":false,"publicRoutes":[],"mcp":null,"scope":"org","organizationId":"<uuid-1>","organizationName":"Acme","gatewayUrl":"https://example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.resources","status":"start","message":"Preparing the app's resources..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.resources","status":"ok","message":"The app's resources are ready."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.install","status":"start","message":"Installing dependencies..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.install","status":"ok"}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.build","status":"start","message":"Building..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.build","status":"ok","message":"Built the app and checked its Worker.","data":{"release":false,"workflows":[]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.upload","status":"start","message":"Uploading every-acme-agentic-inbox..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.upload","status":"ok","message":"Uploaded version every-acme-agentic-inbox-version-11.","data":{"versionId":"every-acme-agentic-inbox-version-11"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"warning","code":"APP_NEEDS_SETUP","step":"app.secrets","message":"agentic-inbox won't open until WORKERS_AI_API_TOKEN and OPENROUTER_API_KEY are set","data":{"setup":{"ready":false,"settings":[{"kind":"provider","id":"workers-ai","label":"Workers AI","holder":"gateway","names":["WORKERS_AI_API_TOKEN"],"need":{"kind":"required"},"docs":"https://dash.cloudflare.com/profile/api-tokens","setup":"setup/workers-ai.md","hint":"A Cloudflare API token with Workers AI Read (the Workers AI page's prefilled token); the account is the Gateway's own.","set":false,"blocking":true},{"kind":"provider","id":"openrouter","label":"OpenRouter","holder":"gateway","names":["OPENROUTER_API_KEY"],"need":{"kind":"required"},"docs":"https://openrouter.ai/settings/keys","setup":"setup/openrouter.md","hint":"An API key from OpenRouter's keys page; the Gateway puts it on every call as a bearer token.","set":false,"blocking":true}],"unmet":[{"kind":"provider","id":"workers-ai","label":"Workers AI","holder":"gateway","names":["WORKERS_AI_API_TOKEN"],"need":{"kind":"required"},"docs":"https://dash.cloudflare.com/profile/api-tokens","setup":"setup/workers-ai.md","hint":"A Cloudflare API token with Workers AI Read (the Workers AI page's prefilled token); the account is the Gateway's own.","set":false,"blocking":true},{"kind":"provider","id":"openrouter","label":"OpenRouter","holder":"gateway","names":["OPENROUTER_API_KEY"],"need":{"kind":"required"},"docs":"https://openrouter.ai/settings/keys","setup":"setup/openrouter.md","hint":"An API key from OpenRouter's keys page; the Gateway puts it on every call as a bearer token.","set":false,"blocking":true}],"groups":[],"command":{"command":"pnpm everyapp configure agentic-inbox"}}}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.live","status":"ok","message":"agentic-inbox is live at https://agentic-inbox.example.com.","data":{"hostname":"agentic-inbox.example.com","url":"https://agentic-inbox.example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.delete","status":"start","message":"Removing agentic-inbox from the Gateway...","data":{"appId":"agentic-inbox"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"gateway.deploy","status":"start","message":"Uploading Gateway 0.2.0 with 0 apps","data":{"appWorkers":[],"domains":["example.com"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"gateway.deploy","status":"ok","message":"Uploaded version every-app-gateway-version-13","data":{"versionId":"every-app-gateway-version-13"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.delete","status":"ok","message":"agentic-inbox is deleted on the gateway; agentic-inbox.example.com stops serving it.","data":{"appId":"agentic-inbox","hostname":"agentic-inbox.example.com","workerName":"every-acme-agentic-inbox","alreadyDeleted":false}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.certificate","status":"ok","message":"Removed agentic-inbox.example.com's certificate.","data":{"hostname":"agentic-inbox.example.com","certificatePacks":["pack-10"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.purge","status":"start","message":"Deleting agentic-inbox's Worker and data...","data":{"appId":"agentic-inbox"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.purge","status":"ok","message":"Deleted Worker \"every-acme-agentic-inbox\".","data":{"appId":"agentic-inbox","removed":["Worker \"every-acme-agentic-inbox\""],"kinds":["Worker"]}}

## uploads

### every-acme-agentic-inbox (text; secrets EVERY_APP_ORG_ID,GATEWAY_URL)
{
  "name": "every-acme-agentic-inbox",
  "compatibilityDate": "2026-06-01",
  "compatibilityFlags": [
    "nodejs_compat"
  ],
  "workersDev": false,
  "previewUrls": false,
  "observability": {
    "enabled": true,
    "headSamplingRate": 1,
    "redactQueryString": true,
    "logs": {
      "enabled": true,
      "invocationLogs": true,
      "persist": true,
      "headSamplingRate": 1
    },
    "traces": {
      "enabled": true,
      "persist": true,
      "headSamplingRate": 0.1
    },
    "issues": {
      "enabled": true
    }
  },
  "env": {
    "EVERYAPP_APP_ID": {
      "type": "text",
      "value": "agentic-inbox"
    },
    "EVERYAPP_MANIFEST": {
      "type": "json",
      "value": {
        "id": "agentic-inbox",
        "name": "Agentic Inbox",
        "description": "An email client with an AI agent, for the organization's own domains.",
        "resources": {
          "durableObjects": [
            {
              "name": "MAILBOX",
              "className": "MailboxDO"
            },
            {
              "name": "EMAIL_AGENT",
              "className": "EmailAgent"
            }
          ]
        },
        "providers": [
          "workers-ai",
          "openrouter"
        ],
        "ai": {
          "models": [
            "@cf/meta/llama-4-scout-17b-16e-instruct",
            "@cf/meta/llama-3.1-8b-instruct-fast",
            "@cf/moonshotai/kimi-k2.6",
            "meta-llama/llama-4-scout",
            "meta-llama/llama-3.1-8b-instruct",
            "moonshotai/kimi-k2"
          ]
        },
        "access": "everyone",
        "public": []
      }
    },
    "CF_VERSION_METADATA": {
      "type": "version-metadata"
    },
    "EVERYAPP_AUDIENCE": {
      "type": "text",
      "value": "every-acme-agentic-inbox"
    },
    "EVERYAPP_IDENTITY_PUBLIC_KEYS": {
      "type": "text",
      "value": "[\"<public-key>\\n\"]"
    },
    "EVERYAPP_IDENTITY_ISSUER": {
      "type": "text",
      "value": "https://example.com"
    },
    "EVERY_APP_GATEWAY": {
      "type": "worker",
      "worker": "every-app-gateway",
      "exportName": "AppGateway",
      "props": {
        "organizationId": "<uuid-1>",
        "appId": "agentic-inbox",
        "workerName": "every-acme-agentic-inbox"
      }
    },
    "GATEWAY_URL": {
      "type": "secret"
    },
    "EVERY_APP_ORG_ID": {
      "type": "secret"
    },
    "MAILBOX": {
      "type": "durable-object",
      "worker": "every-acme-agentic-inbox",
      "exportName": "MailboxDO"
    },
    "EMAIL_AGENT": {
      "type": "durable-object",
      "worker": "every-acme-agentic-inbox",
      "exportName": "EmailAgent"
    },
    "BUCKET": {
      "type": "r2",
      "name": "every-acme-agentic-inbox"
    },
    "DOMAINS": {
      "type": "text",
      "value": "example.com"
    },
    "EMAIL_ADDRESSES": {
      "type": "json",
      "value": []
    },
    "AI_PROVIDER": {
      "type": "text",
      "value": "workers-ai"
    },
    "AGENT_MODEL": {
      "type": "text",
      "value": ""
    }
  },
  "exports": {
    "MailboxDO": {
      "type": "durable-object",
      "storage": "sqlite"
    },
    "EmailAgent": {
      "type": "durable-object",
      "storage": "sqlite"
    }
  },
  "manifest": {
    "type": "partial",
    "mainModule": "index.js",
    "modules": {
      "assets/x.js.map": {
        "type": "sourcemap"
      }
    }
  }
}
### every-app-gateway (text; secrets none)
{
  "name": "every-app-gateway",
  "compatibilityDate": "2025-09-02",
  "compatibilityFlags": [
    "nodejs_compat",
    "global_fetch_strictly_public"
  ],
  "assets": {
    "runWorkerFirst": true
  },
  "triggers": [
    {
      "type": "scheduled",
      "schedule": "17 * * * *"
    }
  ],
  "observability": {
    "enabled": true,
    "headSamplingRate": 1,
    "redactQueryString": true,
    "issues": {
      "enabled": true
    },
    "logs": {
      "enabled": true,
      "headSamplingRate": 1,
      "invocationLogs": true,
      "persist": true
    },
    "traces": {
      "enabled": true,
      "headSamplingRate": 0.1,
      "persist": true
    }
  },
  "workersDev": false,
  "previewUrls": false,
  "env": {
    "ASSETS": {
      "type": "assets"
    },
    "DB": {
      "type": "d1",
      "name": "every-app-gateway",
      "id": "00000001-0000-4000-8000-000000000000"
    },
    "OAUTH_KV": {
      "type": "kv",
      "id": "00000000000000000000000000000002"
    },
    "EMAIL": {
      "type": "send-email"
    },
    "CF_VERSION_METADATA": {
      "type": "version-metadata"
    },
    "AUTH_RATE_LIMIT_IP": {
      "type": "rate-limit",
      "namespace": "4180",
      "simple": {
        "limit": 60,
        "period": 60
      }
    },
    "AUTH_RATE_LIMIT_EMAIL": {
      "type": "rate-limit",
      "namespace": "4181",
      "simple": {
        "limit": 10,
        "period": 60
      }
    },
    "AUTH_RATE_LIMIT_ACCOUNT": {
      "type": "rate-limit",
      "namespace": "4182",
      "simple": {
        "limit": 30,
        "period": 60
      }
    },
    "GATEWAY_URL": {
      "type": "secret"
    },
    "BETTER_AUTH_SECRET": {
      "type": "secret"
    },
    "JWT_PRIVATE_KEY": {
      "type": "secret"
    },
    "JWT_PUBLIC_KEY": {
      "type": "secret"
    },
    "EVERYAPP_RELEASE": {
      "type": "json",
      "value": {
        "version": "0.2.0",
        "sha256": "<release-sha256>"
      }
    },
    "APP_BASE_DOMAIN": {
      "type": "text",
      "value": "example.com"
    },
    "APP__every-acme-agentic-inbox": {
      "type": "worker",
      "worker": "every-acme-agentic-inbox"
    }
  },
  "manifest": {
    "type": "partial",
    "mainModule": "index.js",
    "modules": {
      "index.js.map": {
        "type": "sourcemap"
      }
    }
  },
  "domains": [
    "example.com",
    "agentic-inbox.example.com"
  ]
}
### every-acme-agentic-inbox (text; secrets EVERY_APP_ORG_ID,GATEWAY_URL)
{
  "name": "every-acme-agentic-inbox",
  "compatibilityDate": "2026-06-01",
  "compatibilityFlags": [
    "nodejs_compat"
  ],
  "workersDev": false,
  "previewUrls": false,
  "observability": {
    "enabled": true,
    "headSamplingRate": 1,
    "redactQueryString": true,
    "logs": {
      "enabled": true,
      "invocationLogs": true,
      "persist": true,
      "headSamplingRate": 1
    },
    "traces": {
      "enabled": true,
      "persist": true,
      "headSamplingRate": 0.1
    },
    "issues": {
      "enabled": true
    }
  },
  "env": {
    "EVERYAPP_APP_ID": {
      "type": "text",
      "value": "agentic-inbox"
    },
    "EVERYAPP_MANIFEST": {
      "type": "json",
      "value": {
        "id": "agentic-inbox",
        "name": "Agentic Inbox",
        "description": "An email client with an AI agent, for the organization's own domains.",
        "resources": {
          "durableObjects": [
            {
              "name": "MAILBOX",
              "className": "MailboxDO"
            },
            {
              "name": "EMAIL_AGENT",
              "className": "EmailAgent"
            }
          ]
        },
        "providers": [
          "workers-ai",
          "openrouter"
        ],
        "ai": {
          "models": [
            "@cf/meta/llama-4-scout-17b-16e-instruct",
            "@cf/meta/llama-3.1-8b-instruct-fast",
            "@cf/moonshotai/kimi-k2.6",
            "meta-llama/llama-4-scout",
            "meta-llama/llama-3.1-8b-instruct",
            "moonshotai/kimi-k2"
          ]
        },
        "access": "everyone",
        "public": []
      }
    },
    "CF_VERSION_METADATA": {
      "type": "version-metadata"
    },
    "EVERYAPP_AUDIENCE": {
      "type": "text",
      "value": "every-acme-agentic-inbox"
    },
    "EVERYAPP_IDENTITY_PUBLIC_KEYS": {
      "type": "text",
      "value": "[\"<public-key>\\n\"]"
    },
    "EVERYAPP_IDENTITY_ISSUER": {
      "type": "text",
      "value": "https://example.com"
    },
    "EVERY_APP_GATEWAY": {
      "type": "worker",
      "worker": "every-app-gateway",
      "exportName": "AppGateway",
      "props": {
        "organizationId": "<uuid-1>",
        "appId": "agentic-inbox",
        "workerName": "every-acme-agentic-inbox"
      }
    },
    "GATEWAY_URL": {
      "type": "secret"
    },
    "EVERY_APP_ORG_ID": {
      "type": "secret"
    },
    "MAILBOX": {
      "type": "durable-object",
      "worker": "every-acme-agentic-inbox",
      "exportName": "MailboxDO"
    },
    "EMAIL_AGENT": {
      "type": "durable-object",
      "worker": "every-acme-agentic-inbox",
      "exportName": "EmailAgent"
    },
    "BUCKET": {
      "type": "r2",
      "name": "every-acme-agentic-inbox"
    },
    "DOMAINS": {
      "type": "text",
      "value": "example.com"
    },
    "EMAIL_ADDRESSES": {
      "type": "json",
      "value": []
    },
    "AI_PROVIDER": {
      "type": "text",
      "value": "workers-ai"
    },
    "AGENT_MODEL": {
      "type": "text",
      "value": ""
    }
  },
  "exports": {
    "MailboxDO": {
      "type": "durable-object",
      "storage": "sqlite"
    },
    "EmailAgent": {
      "type": "durable-object",
      "storage": "sqlite"
    }
  },
  "manifest": {
    "type": "partial",
    "mainModule": "index.js",
    "modules": {
      "assets/x.js.map": {
        "type": "sourcemap"
      }
    }
  }
}
### every-app-gateway (text; secrets none)
{
  "name": "every-app-gateway",
  "compatibilityDate": "2025-09-02",
  "compatibilityFlags": [
    "nodejs_compat",
    "global_fetch_strictly_public"
  ],
  "assets": {
    "runWorkerFirst": true
  },
  "triggers": [
    {
      "type": "scheduled",
      "schedule": "17 * * * *"
    }
  ],
  "observability": {
    "enabled": true,
    "headSamplingRate": 1,
    "redactQueryString": true,
    "issues": {
      "enabled": true
    },
    "logs": {
      "enabled": true,
      "headSamplingRate": 1,
      "invocationLogs": true,
      "persist": true
    },
    "traces": {
      "enabled": true,
      "headSamplingRate": 0.1,
      "persist": true
    }
  },
  "workersDev": false,
  "previewUrls": false,
  "env": {
    "ASSETS": {
      "type": "assets"
    },
    "DB": {
      "type": "d1",
      "name": "every-app-gateway",
      "id": "00000001-0000-4000-8000-000000000000"
    },
    "OAUTH_KV": {
      "type": "kv",
      "id": "00000000000000000000000000000002"
    },
    "EMAIL": {
      "type": "send-email"
    },
    "CF_VERSION_METADATA": {
      "type": "version-metadata"
    },
    "AUTH_RATE_LIMIT_IP": {
      "type": "rate-limit",
      "namespace": "4180",
      "simple": {
        "limit": 60,
        "period": 60
      }
    },
    "AUTH_RATE_LIMIT_EMAIL": {
      "type": "rate-limit",
      "namespace": "4181",
      "simple": {
        "limit": 10,
        "period": 60
      }
    },
    "AUTH_RATE_LIMIT_ACCOUNT": {
      "type": "rate-limit",
      "namespace": "4182",
      "simple": {
        "limit": 30,
        "period": 60
      }
    },
    "GATEWAY_URL": {
      "type": "secret"
    },
    "BETTER_AUTH_SECRET": {
      "type": "secret"
    },
    "JWT_PRIVATE_KEY": {
      "type": "secret"
    },
    "JWT_PUBLIC_KEY": {
      "type": "secret"
    },
    "EVERYAPP_RELEASE": {
      "type": "json",
      "value": {
        "version": "0.2.0",
        "sha256": "<release-sha256>"
      }
    },
    "APP_BASE_DOMAIN": {
      "type": "text",
      "value": "example.com"
    }
  },
  "manifest": {
    "type": "partial",
    "mainModule": "index.js",
    "modules": {
      "index.js.map": {
        "type": "sourcemap"
      }
    }
  },
  "domains": [
    "example.com"
  ]
}

## cf calls

account json cf auth whoami
account json cf d1 list --name every-app-gateway --per-page 100
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf dns records list -z zone-1 --name-exact agentic-inbox.example.com --per-page 100
account json cf dns records list -z zone-1 --name-exact *.example.com --per-page 100
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-agentic-inbox --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
project text cf build cwd=<app>
account json cf r2 buckets list --name-contains every-acme-agentic-inbox --per-page 100
account json cf r2 buckets create --name every-acme-agentic-inbox
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-agentic-inbox --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-agentic-inbox --per-page 10
project text cf deploy --prebuilt --no-provision --mode production --message everyapp 0.3.0 agentic-inbox --secrets-file /fake-cf-files/secrets.json files=secrets.json cwd=<app>
account json cf workers deployments list --worker every-acme-agentic-inbox --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers secrets list --worker every-acme-agentic-inbox
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers secrets list --worker every-app-gateway
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-app-gateway --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-agentic-inbox --per-page 10
account json cf dns records list -z zone-1 --name-exact agentic-inbox.example.com --per-page 100
account json cf dns records list -z zone-1 --name-exact *.example.com --per-page 100
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-app-gateway --per-page 10
project text cf deploy --prebuilt --no-provision --mode production --message everyapp 0.3.0 gateway 0.2.0 (reconcile) cwd=<home>/.everyapp/cf/tmp/gateway-deploy-<tmp>
account json cf workers deployments list --worker every-app-gateway --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf zero-trust access applications list --per-page 100 --page 1
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf auth whoami
account json cf d1 list --name every-app-gateway --per-page 100
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
project text cf build cwd=<app>
account json cf r2 buckets list --name-contains every-acme-agentic-inbox --per-page 100
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-agentic-inbox --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-agentic-inbox --per-page 10
project text cf deploy --prebuilt --no-provision --mode production --message everyapp 0.3.0 agentic-inbox --secrets-file /fake-cf-files/secrets.json files=secrets.json cwd=<app>
account json cf workers deployments list --worker every-acme-agentic-inbox --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers secrets list --worker every-acme-agentic-inbox
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers secrets list --worker every-app-gateway
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf zero-trust access applications list --per-page 100 --page 1
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf auth whoami
account json cf d1 list --name every-app-gateway --per-page 100
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-app-gateway --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-app-gateway --per-page 10
project text cf deploy --prebuilt --no-provision --mode production --message everyapp 0.3.0 gateway 0.2.0 (reconcile) cwd=<home>/.everyapp/cf/tmp/gateway-deploy-<tmp>
account json cf workers deployments list --worker every-app-gateway --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf zero-trust access applications list --per-page 100 --page 1
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf ssl certificate-packs list -z zone-1 --per-page 50 --page 1
account json cf ssl certificate-packs delete pack-10 -z zone-1 --force
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workflows list --search every-acme-agentic-inbox --per-page 100 --page 1
account json cf workers deployments list --worker every-acme-agentic-inbox --per-page 10
account json cf workers delete every-acme-agentic-inbox --force
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json

## ledger after the first deploy

worker "" every-acme-agentic-inbox every-acme-agentic-inbox every-acme-agentic-inbox-version-6

## ledger after the redeploy

worker "" every-acme-agentic-inbox every-acme-agentic-inbox every-acme-agentic-inbox-version-11

## ledger after the purge


