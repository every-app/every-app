## events

{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.connect","status":"start","message":"Finding your Gateway..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.connect","status":"ok","data":{"gatewayUrl":"https://example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.deploy","status":"ok","message":"Deploying postiz to https://example.com.","data":{"appId":"postiz","organizationName":"Acme","firstDeploy":true,"gatewayUrl":"https://example.com","gatewayHost":"example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.register","status":"ok","message":"Registered postiz as every-acme-postiz at https://postiz.example.com (pending).","data":{"appId":"postiz","workerName":"every-acme-postiz","hostname":"postiz.example.com","status":"pending","existingApp":false,"firstDeploy":true,"defaultAccess":true,"deployerAccess":false,"hasOwner":false,"publicRoutes":[],"mcp":null,"scope":"org","organizationId":"<uuid-1>","organizationName":"Acme","gatewayUrl":"https://example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"warning","code":"CUSTOM_DOMAIN_OWNER_UNCHECKED","step":"app.domain","message":"If another Worker already serves postiz.example.com, it will be replaced by this deployment.","data":{"hosts":["postiz.example.com"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.resources","status":"start","message":"Preparing the app's resources..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"progress","step":"app.resources","message":"Created D1 database \"every-acme-postiz\"."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.resources","status":"ok","message":"The app's resources are ready."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.install","status":"start","message":"Installing dependencies..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.install","status":"ok"}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.build","status":"start","message":"Building..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"progress","step":"app.build","message":"Created R2 bucket \"every-acme-postiz\".","data":{"bucket":"every-acme-postiz"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.build","status":"ok","message":"Built the app and checked its Workers.","data":{"release":false,"workflows":["every-acme-postiz--publish-post"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.migrations","status":"start","message":"Migrating the database..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.migrations","status":"ok","message":"Applied 0001_init.sql.","data":{"applied":["0001_init.sql"],"fresh":true}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.helper","status":"start","message":"Uploading every-acme-postiz--api...","data":{"name":"api","workerName":"every-acme-postiz--api"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.helper","status":"ok","message":"Uploaded every-acme-postiz--api.","data":{"name":"api","workerName":"every-acme-postiz--api"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.upload","status":"start","message":"Uploading every-acme-postiz..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.upload","status":"ok","message":"Uploaded version every-acme-postiz-version-9.","data":{"versionId":"every-acme-postiz-version-9"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"warning","code":"APP_NEEDS_SETUP","step":"app.secrets","message":"postiz won't open until OPENAI_API_KEY, JWT_SECRET, X_API_KEY and X_API_SECRET are set","data":{"setup":{"ready":false,"settings":[{"kind":"provider","id":"openai","label":"OpenAI","holder":"gateway","names":["OPENAI_API_KEY"],"need":{"kind":"required"},"docs":"https://platform.openai.com/api-keys","setup":"setup/openai.md","hint":"A secret key from the API keys page; the Gateway puts it on every call as a bearer token.","set":false,"blocking":true},{"kind":"secret","id":"JWT_SECRET","label":"JWT_SECRET","holder":"app","names":["JWT_SECRET"],"need":{"kind":"required"},"set":false,"blocking":true},{"kind":"secret","id":"X_API_KEY","label":"X_API_KEY","holder":"app","names":["X_API_KEY"],"need":{"kind":"required"},"set":false,"blocking":true},{"kind":"secret","id":"X_API_SECRET","label":"X_API_SECRET","holder":"app","names":["X_API_SECRET"],"need":{"kind":"required"},"set":false,"blocking":true}],"unmet":[{"kind":"provider","id":"openai","label":"OpenAI","holder":"gateway","names":["OPENAI_API_KEY"],"need":{"kind":"required"},"docs":"https://platform.openai.com/api-keys","setup":"setup/openai.md","hint":"A secret key from the API keys page; the Gateway puts it on every call as a bearer token.","set":false,"blocking":true},{"kind":"secret","id":"JWT_SECRET","label":"JWT_SECRET","holder":"app","names":["JWT_SECRET"],"need":{"kind":"required"},"set":false,"blocking":true},{"kind":"secret","id":"X_API_KEY","label":"X_API_KEY","holder":"app","names":["X_API_KEY"],"need":{"kind":"required"},"set":false,"blocking":true},{"kind":"secret","id":"X_API_SECRET","label":"X_API_SECRET","holder":"app","names":["X_API_SECRET"],"need":{"kind":"required"},"set":false,"blocking":true}],"groups":[],"command":{"command":"pnpm everyapp configure postiz"}}}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.bind","status":"start","message":"Binding APP__every-acme-postiz on the gateway and publishing its hostname...","data":{"appId":"postiz"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"gateway.deploy","status":"start","message":"Uploading Gateway 0.2.0 with 1 app","data":{"appWorkers":["every-acme-postiz"],"domains":["example.com","postiz.example.com"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"gateway.deploy","status":"ok","message":"Uploaded version every-app-gateway-version-11","data":{"versionId":"every-app-gateway-version-11"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.bind","status":"ok","message":"The gateway binds APP__every-acme-postiz (gateway version every-app-gateway-version-11).","data":{"versionId":"every-app-gateway-version-11","newHosts":["postiz.example.com"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.live","status":"ok","message":"postiz is live at https://postiz.example.com.","data":{"hostname":"postiz.example.com","url":"https://postiz.example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.connect","status":"start","message":"Finding your Gateway..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.connect","status":"ok","data":{"gatewayUrl":"https://example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.deploy","status":"ok","message":"Deploying postiz to https://example.com.","data":{"appId":"postiz","organizationName":"Acme","firstDeploy":false,"gatewayUrl":"https://example.com","gatewayHost":"example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.register","status":"ok","message":"Updating postiz as every-acme-postiz at https://postiz.example.com (active).","data":{"appId":"postiz","workerName":"every-acme-postiz","hostname":"postiz.example.com","status":"active","existingApp":true,"firstDeploy":false,"defaultAccess":true,"deployerAccess":false,"hasOwner":false,"publicRoutes":[],"mcp":null,"scope":"org","organizationId":"<uuid-1>","organizationName":"Acme","gatewayUrl":"https://example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.resources","status":"start","message":"Preparing the app's resources..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.resources","status":"ok","message":"The app's resources are ready."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.install","status":"start","message":"Installing dependencies..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.install","status":"ok"}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.build","status":"start","message":"Building..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.build","status":"ok","message":"Built the app and checked its Workers.","data":{"release":false,"workflows":["every-acme-postiz--publish-post"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.migrations","status":"start","message":"Migrating the database..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.migrations","status":"ok","message":"The app's database is up to date.","data":{"applied":[],"fresh":false}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.helper","status":"start","message":"Uploading every-acme-postiz--api...","data":{"name":"api","workerName":"every-acme-postiz--api"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.helper","status":"ok","message":"Uploaded every-acme-postiz--api.","data":{"name":"api","workerName":"every-acme-postiz--api"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.upload","status":"start","message":"Uploading every-acme-postiz..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.upload","status":"ok","message":"Uploaded version every-acme-postiz-version-16.","data":{"versionId":"every-acme-postiz-version-16"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"warning","code":"APP_NEEDS_SETUP","step":"app.secrets","message":"postiz won't open until OPENAI_API_KEY, JWT_SECRET, X_API_KEY and X_API_SECRET are set","data":{"setup":{"ready":false,"settings":[{"kind":"provider","id":"openai","label":"OpenAI","holder":"gateway","names":["OPENAI_API_KEY"],"need":{"kind":"required"},"docs":"https://platform.openai.com/api-keys","setup":"setup/openai.md","hint":"A secret key from the API keys page; the Gateway puts it on every call as a bearer token.","set":false,"blocking":true},{"kind":"secret","id":"JWT_SECRET","label":"JWT_SECRET","holder":"app","names":["JWT_SECRET"],"need":{"kind":"required"},"set":false,"blocking":true},{"kind":"secret","id":"X_API_KEY","label":"X_API_KEY","holder":"app","names":["X_API_KEY"],"need":{"kind":"required"},"set":false,"blocking":true},{"kind":"secret","id":"X_API_SECRET","label":"X_API_SECRET","holder":"app","names":["X_API_SECRET"],"need":{"kind":"required"},"set":false,"blocking":true}],"unmet":[{"kind":"provider","id":"openai","label":"OpenAI","holder":"gateway","names":["OPENAI_API_KEY"],"need":{"kind":"required"},"docs":"https://platform.openai.com/api-keys","setup":"setup/openai.md","hint":"A secret key from the API keys page; the Gateway puts it on every call as a bearer token.","set":false,"blocking":true},{"kind":"secret","id":"JWT_SECRET","label":"JWT_SECRET","holder":"app","names":["JWT_SECRET"],"need":{"kind":"required"},"set":false,"blocking":true},{"kind":"secret","id":"X_API_KEY","label":"X_API_KEY","holder":"app","names":["X_API_KEY"],"need":{"kind":"required"},"set":false,"blocking":true},{"kind":"secret","id":"X_API_SECRET","label":"X_API_SECRET","holder":"app","names":["X_API_SECRET"],"need":{"kind":"required"},"set":false,"blocking":true}],"groups":[],"command":{"command":"pnpm everyapp configure postiz"}}}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.live","status":"ok","message":"postiz is live at https://postiz.example.com.","data":{"hostname":"postiz.example.com","url":"https://postiz.example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.delete","status":"start","message":"Removing postiz from the Gateway...","data":{"appId":"postiz"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"gateway.deploy","status":"start","message":"Uploading Gateway 0.2.0 with 0 apps","data":{"appWorkers":[],"domains":["example.com"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"gateway.deploy","status":"ok","message":"Uploaded version every-app-gateway-version-18","data":{"versionId":"every-app-gateway-version-18"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.delete","status":"ok","message":"postiz is deleted on the gateway; postiz.example.com stops serving it.","data":{"appId":"postiz","hostname":"postiz.example.com","workerName":"every-acme-postiz","alreadyDeleted":false}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.certificate","status":"ok","message":"Removed postiz.example.com's certificate.","data":{"hostname":"postiz.example.com","certificatePacks":["pack-13"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.purge","status":"start","message":"Deleting postiz's Worker and data...","data":{"appId":"postiz"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.purge","status":"ok","message":"Deleted Workflow \"every-acme-postiz--publish-post\", Worker \"every-acme-postiz\", Worker \"every-acme-postiz--api\", D1 database \"every-acme-postiz\".","data":{"appId":"postiz","removed":["Workflow \"every-acme-postiz--publish-post\"","Worker \"every-acme-postiz\"","Worker \"every-acme-postiz--api\"","D1 database \"every-acme-postiz\""],"kinds":["2 Workers","Workflow","D1 database"]}}

## uploads

### every-acme-postiz--api (text; secrets EVERY_APP_ORG_ID,GATEWAY_URL)
{
  "name": "every-acme-postiz--api",
  "compatibilityDate": "2026-06-01",
  "compatibilityFlags": [
    "nodejs_compat",
    "global_fetch_strictly_public"
  ],
  "workersDev": false,
  "previewUrls": false,
  "triggers": [
    {
      "type": "scheduled",
      "schedule": "*/10 * * * *"
    }
  ],
  "limits": {
    "cpuMs": 300000
  },
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
      "value": "postiz"
    },
    "DB": {
      "type": "d1",
      "name": "every-acme-postiz",
      "id": "00000006-0000-4000-8000-000000000000"
    },
    "EVERY_APP_GATEWAY": {
      "type": "worker",
      "worker": "every-app-gateway",
      "exportName": "AppGateway",
      "props": {
        "organizationId": "<uuid-1>",
        "appId": "postiz",
        "workerName": "every-acme-postiz"
      }
    },
    "GATEWAY_URL": {
      "type": "secret"
    },
    "EVERY_APP_ORG_ID": {
      "type": "secret"
    },
    "DATABASE_PROVIDER": {
      "type": "text",
      "value": "d1"
    },
    "PUBLISH_POST": {
      "type": "workflow",
      "name": "every-acme-postiz--publish-post",
      "worker": "every-acme-postiz--api",
      "exportName": "PublishPostWorkflow"
    },
    "R2": {
      "type": "r2",
      "name": "every-acme-postiz"
    },
    "IS_GENERAL": {
      "type": "text",
      "value": "true"
    },
    "POSTIZ_FEATURES": {
      "type": "json",
      "value": {
        "ai": true,
        "agents": false,
        "analytics": false,
        "autopost": false,
        "plugs": false,
        "thirdParty": false,
        "webhooks": false,
        "sets": false,
        "publicApi": false,
        "team": "readonly",
        "preview": false,
        "billing": false,
        "email": false
      }
    },
    "EVERYAPP_HEADER_AUTH": {
      "type": "text",
      "value": "true"
    },
    "AI_ENABLED": {
      "type": "text",
      "value": "true"
    }
  },
  "exports": {
    "PublishPostWorkflow": {
      "type": "workflow",
      "name": "every-acme-postiz--publish-post"
    }
  },
  "manifest": {
    "type": "partial",
    "mainModule": "index.js",
    "modules": {}
  }
}
### every-acme-postiz (text; secrets EVERY_APP_ORG_ID,GATEWAY_URL)
{
  "name": "every-acme-postiz",
  "compatibilityDate": "2026-06-01",
  "compatibilityFlags": [
    "nodejs_compat",
    "global_fetch_strictly_public"
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
      "value": "postiz"
    },
    "EVERYAPP_MANIFEST": {
      "type": "json",
      "value": {
        "id": "postiz",
        "name": "Postiz",
        "description": "Schedule and publish social media posts from one calendar.",
        "resources": {
          "d1": [
            "DB"
          ],
          "workflows": [
            {
              "name": "PUBLISH_POST",
              "className": "PublishPostWorkflow",
              "worker": "api"
            }
          ]
        },
        "workers": [
          {
            "name": "api",
            "binding": "API",
            "limits": {
              "cpuMs": 300000
            }
          }
        ],
        "database": {
          "provider": "d1"
        },
        "migrations": {
          "engine": "d1-sql",
          "dir": "migrations",
          "binding": "DB"
        },
        "providers": [
          "openai"
        ],
        "ai": {
          "models": [
            "gpt-4.1",
            "gpt-4o-2024-08-06",
            "gpt-5.2",
            "chatgpt-image-latest"
          ]
        },
        "secrets": [
          "JWT_SECRET",
          "X_API_KEY",
          "X_API_SECRET"
        ],
        "public": [],
        "access": "everyone",
        "install": "pnpm install --frozen-lockfile",
        "dev": "pnpm exec vite build --mode development && pnpm exec vite preview --host 127.0.0.1 --port $PORT"
      }
    },
    "CF_VERSION_METADATA": {
      "type": "version-metadata"
    },
    "EVERYAPP_AUDIENCE": {
      "type": "text",
      "value": "every-acme-postiz"
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
        "appId": "postiz",
        "workerName": "every-acme-postiz"
      }
    },
    "GATEWAY_URL": {
      "type": "secret"
    },
    "EVERY_APP_ORG_ID": {
      "type": "secret"
    },
    "DB": {
      "type": "d1",
      "name": "every-acme-postiz",
      "id": "00000006-0000-4000-8000-000000000000"
    },
    "DATABASE_PROVIDER": {
      "type": "text",
      "value": "d1"
    },
    "PUBLISH_POST": {
      "type": "workflow",
      "name": "every-acme-postiz--publish-post",
      "worker": "every-acme-postiz--api",
      "exportName": "PublishPostWorkflow"
    },
    "API": {
      "type": "worker",
      "worker": "every-acme-postiz--api"
    },
    "R2": {
      "type": "r2",
      "name": "every-acme-postiz"
    },
    "IS_GENERAL": {
      "type": "text",
      "value": "true"
    },
    "POSTIZ_FEATURES": {
      "type": "json",
      "value": {
        "ai": true,
        "agents": false,
        "analytics": false,
        "autopost": false,
        "plugs": false,
        "thirdParty": false,
        "webhooks": false,
        "sets": false,
        "publicApi": false,
        "team": "readonly",
        "preview": false,
        "billing": false,
        "email": false
      }
    },
    "EVERYAPP_HEADER_AUTH": {
      "type": "text",
      "value": "true"
    },
    "AI_ENABLED": {
      "type": "text",
      "value": "true"
    },
    "ASSETS": {
      "type": "assets"
    },
    "NEXT_PUBLIC_BACKEND_URL": {
      "type": "text",
      "value": "/api"
    },
    "NEXT_PUBLIC_VERSION": {
      "type": "text",
      "value": "everyapp"
    }
  },
  "exports": {},
  "assets": {
    "htmlHandling": "none",
    "notFoundHandling": "none",
    "runWorkerFirst": [
      "/*",
      "!/_next/static/*",
      "!/*/_next/static/*"
    ]
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
    "APP__every-acme-postiz": {
      "type": "worker",
      "worker": "every-acme-postiz"
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
    "postiz.example.com"
  ]
}
### every-acme-postiz--api (text; secrets EVERY_APP_ORG_ID,GATEWAY_URL)
{
  "name": "every-acme-postiz--api",
  "compatibilityDate": "2026-06-01",
  "compatibilityFlags": [
    "nodejs_compat",
    "global_fetch_strictly_public"
  ],
  "workersDev": false,
  "previewUrls": false,
  "triggers": [
    {
      "type": "scheduled",
      "schedule": "*/10 * * * *"
    }
  ],
  "limits": {
    "cpuMs": 300000
  },
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
      "value": "postiz"
    },
    "DB": {
      "type": "d1",
      "name": "every-acme-postiz",
      "id": "00000006-0000-4000-8000-000000000000"
    },
    "EVERY_APP_GATEWAY": {
      "type": "worker",
      "worker": "every-app-gateway",
      "exportName": "AppGateway",
      "props": {
        "organizationId": "<uuid-1>",
        "appId": "postiz",
        "workerName": "every-acme-postiz"
      }
    },
    "GATEWAY_URL": {
      "type": "secret"
    },
    "EVERY_APP_ORG_ID": {
      "type": "secret"
    },
    "DATABASE_PROVIDER": {
      "type": "text",
      "value": "d1"
    },
    "PUBLISH_POST": {
      "type": "workflow",
      "name": "every-acme-postiz--publish-post",
      "worker": "every-acme-postiz--api",
      "exportName": "PublishPostWorkflow"
    },
    "R2": {
      "type": "r2",
      "name": "every-acme-postiz"
    },
    "IS_GENERAL": {
      "type": "text",
      "value": "true"
    },
    "POSTIZ_FEATURES": {
      "type": "json",
      "value": {
        "ai": true,
        "agents": false,
        "analytics": false,
        "autopost": false,
        "plugs": false,
        "thirdParty": false,
        "webhooks": false,
        "sets": false,
        "publicApi": false,
        "team": "readonly",
        "preview": false,
        "billing": false,
        "email": false
      }
    },
    "EVERYAPP_HEADER_AUTH": {
      "type": "text",
      "value": "true"
    },
    "AI_ENABLED": {
      "type": "text",
      "value": "true"
    }
  },
  "exports": {
    "PublishPostWorkflow": {
      "type": "workflow",
      "name": "every-acme-postiz--publish-post"
    }
  },
  "manifest": {
    "type": "partial",
    "mainModule": "index.js",
    "modules": {}
  }
}
### every-acme-postiz (text; secrets EVERY_APP_ORG_ID,GATEWAY_URL)
{
  "name": "every-acme-postiz",
  "compatibilityDate": "2026-06-01",
  "compatibilityFlags": [
    "nodejs_compat",
    "global_fetch_strictly_public"
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
      "value": "postiz"
    },
    "EVERYAPP_MANIFEST": {
      "type": "json",
      "value": {
        "id": "postiz",
        "name": "Postiz",
        "description": "Schedule and publish social media posts from one calendar.",
        "resources": {
          "d1": [
            "DB"
          ],
          "workflows": [
            {
              "name": "PUBLISH_POST",
              "className": "PublishPostWorkflow",
              "worker": "api"
            }
          ]
        },
        "workers": [
          {
            "name": "api",
            "binding": "API",
            "limits": {
              "cpuMs": 300000
            }
          }
        ],
        "database": {
          "provider": "d1"
        },
        "migrations": {
          "engine": "d1-sql",
          "dir": "migrations",
          "binding": "DB"
        },
        "providers": [
          "openai"
        ],
        "ai": {
          "models": [
            "gpt-4.1",
            "gpt-4o-2024-08-06",
            "gpt-5.2",
            "chatgpt-image-latest"
          ]
        },
        "secrets": [
          "JWT_SECRET",
          "X_API_KEY",
          "X_API_SECRET"
        ],
        "public": [],
        "access": "everyone",
        "install": "pnpm install --frozen-lockfile",
        "dev": "pnpm exec vite build --mode development && pnpm exec vite preview --host 127.0.0.1 --port $PORT"
      }
    },
    "CF_VERSION_METADATA": {
      "type": "version-metadata"
    },
    "EVERYAPP_AUDIENCE": {
      "type": "text",
      "value": "every-acme-postiz"
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
        "appId": "postiz",
        "workerName": "every-acme-postiz"
      }
    },
    "GATEWAY_URL": {
      "type": "secret"
    },
    "EVERY_APP_ORG_ID": {
      "type": "secret"
    },
    "DB": {
      "type": "d1",
      "name": "every-acme-postiz",
      "id": "00000006-0000-4000-8000-000000000000"
    },
    "DATABASE_PROVIDER": {
      "type": "text",
      "value": "d1"
    },
    "PUBLISH_POST": {
      "type": "workflow",
      "name": "every-acme-postiz--publish-post",
      "worker": "every-acme-postiz--api",
      "exportName": "PublishPostWorkflow"
    },
    "API": {
      "type": "worker",
      "worker": "every-acme-postiz--api"
    },
    "R2": {
      "type": "r2",
      "name": "every-acme-postiz"
    },
    "IS_GENERAL": {
      "type": "text",
      "value": "true"
    },
    "POSTIZ_FEATURES": {
      "type": "json",
      "value": {
        "ai": true,
        "agents": false,
        "analytics": false,
        "autopost": false,
        "plugs": false,
        "thirdParty": false,
        "webhooks": false,
        "sets": false,
        "publicApi": false,
        "team": "readonly",
        "preview": false,
        "billing": false,
        "email": false
      }
    },
    "EVERYAPP_HEADER_AUTH": {
      "type": "text",
      "value": "true"
    },
    "AI_ENABLED": {
      "type": "text",
      "value": "true"
    },
    "ASSETS": {
      "type": "assets"
    },
    "NEXT_PUBLIC_BACKEND_URL": {
      "type": "text",
      "value": "/api"
    },
    "NEXT_PUBLIC_VERSION": {
      "type": "text",
      "value": "everyapp"
    }
  },
  "exports": {},
  "assets": {
    "htmlHandling": "none",
    "notFoundHandling": "none",
    "runWorkerFirst": [
      "/*",
      "!/_next/static/*",
      "!/*/_next/static/*"
    ]
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
account json cf dns records list -z zone-1 --name-exact postiz.example.com --per-page 100
account json cf dns records list -z zone-1 --name-exact *.example.com --per-page 100
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-postiz --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-postiz--api --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 list --name every-acme-postiz --per-page 100
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 create --name every-acme-postiz
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
project text cf build cwd=<app>
account json cf r2 buckets list --name-contains every-acme-postiz --per-page 100
account json cf r2 buckets create --name every-acme-postiz
account json cf workflows get every-acme-postiz--publish-post
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-postiz --per-page 10
account json cf workers deployments list --worker every-acme-postiz--api --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 migrations list 00000006-0000-4000-8000-000000000000 --dir <app>/migrations
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 migrations apply 00000006-0000-4000-8000-000000000000 --dir <app>/migrations
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-postiz--api --per-page 10
project text cf deploy --prebuilt --no-provision --mode production --message everyapp 0.3.0 postiz api --worker every-acme-postiz--api --secrets-file /fake-cf-files/secrets.json files=secrets.json cwd=<app>
account json cf workers deployments list --worker every-acme-postiz--api --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-postiz --per-page 10
project text cf deploy --prebuilt --no-provision --mode production --message everyapp 0.3.0 postiz --secrets-file /fake-cf-files/secrets.json files=secrets.json cwd=<app>
account json cf workers deployments list --worker every-acme-postiz --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers secrets list --worker every-acme-postiz
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
account json cf workers deployments list --worker every-acme-postiz --per-page 10
account json cf dns records list -z zone-1 --name-exact postiz.example.com --per-page 100
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
account json cf d1 list --name every-acme-postiz --per-page 100
project text cf build cwd=<app>
account json cf r2 buckets list --name-contains every-acme-postiz --per-page 100
account json cf workflows get every-acme-postiz--publish-post
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-postiz --per-page 10
account json cf workers deployments list --worker every-acme-postiz--api --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 migrations list 00000006-0000-4000-8000-000000000000 --dir <app>/migrations
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-postiz--api --per-page 10
project text cf deploy --prebuilt --no-provision --mode production --message everyapp 0.3.0 postiz api --worker every-acme-postiz--api --secrets-file /fake-cf-files/secrets.json files=secrets.json cwd=<app>
account json cf workers deployments list --worker every-acme-postiz--api --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-postiz --per-page 10
project text cf deploy --prebuilt --no-provision --mode production --message everyapp 0.3.0 postiz --secrets-file /fake-cf-files/secrets.json files=secrets.json cwd=<app>
account json cf workers deployments list --worker every-acme-postiz --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers secrets list --worker every-acme-postiz
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
account json cf ssl certificate-packs delete pack-13 -z zone-1 --force
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workflows list --search every-acme-postiz --per-page 100 --page 1
account json cf workflows delete every-acme-postiz--publish-post --force
account json cf workers deployments list --worker every-acme-postiz --per-page 10
account json cf workers delete every-acme-postiz --force
account json cf workers deployments list --worker every-acme-postiz--api --per-page 10
account json cf workers delete every-acme-postiz--api --force
account json cf d1 delete 00000006-0000-4000-8000-000000000000 --force
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json

## ledger after the first deploy

d1 "DB" every-acme-postiz 00000006-0000-4000-8000-000000000000 null
worker "" every-acme-postiz every-acme-postiz every-acme-postiz-version-9
worker "api" every-acme-postiz--api every-acme-postiz--api every-acme-postiz--api-version-7

## ledger after the redeploy

d1 "DB" every-acme-postiz 00000006-0000-4000-8000-000000000000 null
worker "" every-acme-postiz every-acme-postiz every-acme-postiz-version-16
worker "api" every-acme-postiz--api every-acme-postiz--api every-acme-postiz--api-version-14

## ledger after the purge


