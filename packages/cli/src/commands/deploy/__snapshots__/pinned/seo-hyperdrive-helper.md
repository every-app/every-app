## events

{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.connect","status":"start","message":"Finding your Gateway..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.connect","status":"ok","data":{"gatewayUrl":"https://example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.deploy","status":"ok","message":"Deploying seo to https://example.com.","data":{"appId":"seo","organizationName":"Acme","firstDeploy":true,"gatewayUrl":"https://example.com","gatewayHost":"example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.register","status":"ok","message":"Registered seo as every-acme-seo at https://seo.example.com (pending).","data":{"appId":"seo","workerName":"every-acme-seo","hostname":"seo.example.com","status":"pending","existingApp":false,"firstDeploy":true,"defaultAccess":false,"deployerAccess":false,"hasOwner":false,"publicRoutes":[],"mcp":null,"scope":"org","organizationId":"<uuid-1>","organizationName":"Acme","gatewayUrl":"https://example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"warning","code":"CUSTOM_DOMAIN_OWNER_UNCHECKED","step":"app.domain","message":"If another Worker already serves seo.example.com, it will be replaced by this deployment.","data":{"hosts":["seo.example.com"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.resources","status":"start","message":"Preparing the app's resources..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"progress","step":"app.resources","message":"Created KV namespace \"every-acme-seo\"."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"progress","step":"app.resources","message":"Created Hyperdrive config \"every-acme-seo--hyperdrive\"."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.resources","status":"ok","message":"The app's resources are ready."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.hyperdrive","status":"ok","message":"Created the app's Hyperdrive config.","data":{"caching":"off"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.install","status":"start","message":"Installing dependencies..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.install","status":"ok"}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.build","status":"start","message":"Building..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.build","status":"ok","message":"Built the app and checked its Workers.","data":{"release":false,"workflows":[]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"warning","code":"SCHEMA_CHECK_SKIPPED","step":"app.schema","message":"Can't check the schema against the migrations: drizzle-kit isn't installed","data":{"fix":"add drizzle-kit to devDependencies"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.migrations","status":"start","message":"Migrating the Postgres database...","data":{"dialect":"postgresql","engine":"drizzle"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.migrations","status":"ok","message":"Migrated the app's Postgres database (drizzle-kit migrate).","data":{"dialect":"postgresql","engine":"drizzle"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.helper","status":"start","message":"Uploading every-acme-seo--audit...","data":{"name":"audit","workerName":"every-acme-seo--audit"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.helper","status":"ok","message":"Uploaded every-acme-seo--audit.","data":{"name":"audit","workerName":"every-acme-seo--audit"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.upload","status":"start","message":"Uploading every-acme-seo..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.upload","status":"ok","message":"Uploaded version every-acme-seo-version-11.","data":{"versionId":"every-acme-seo-version-11"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.bind","status":"start","message":"Binding APP__every-acme-seo on the gateway and publishing its hostname...","data":{"appId":"seo"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"gateway.deploy","status":"start","message":"Uploading Gateway 0.2.0 with 1 app","data":{"appWorkers":["every-acme-seo"],"domains":["example.com","seo.example.com"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"gateway.deploy","status":"ok","message":"Uploaded version every-app-gateway-version-13","data":{"versionId":"every-app-gateway-version-13"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.bind","status":"ok","message":"The gateway binds APP__every-acme-seo (gateway version every-app-gateway-version-13).","data":{"versionId":"every-app-gateway-version-13","newHosts":["seo.example.com"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.live","status":"ok","message":"seo is live at https://seo.example.com.","data":{"hostname":"seo.example.com","url":"https://seo.example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.connect","status":"start","message":"Finding your Gateway..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.connect","status":"ok","data":{"gatewayUrl":"https://example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.deploy","status":"ok","message":"Deploying seo to https://example.com.","data":{"appId":"seo","organizationName":"Acme","firstDeploy":false,"gatewayUrl":"https://example.com","gatewayHost":"example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.register","status":"ok","message":"Updating seo as every-acme-seo at https://seo.example.com (active).","data":{"appId":"seo","workerName":"every-acme-seo","hostname":"seo.example.com","status":"active","existingApp":true,"firstDeploy":false,"defaultAccess":false,"deployerAccess":false,"hasOwner":false,"publicRoutes":[],"mcp":null,"scope":"org","organizationId":"<uuid-1>","organizationName":"Acme","gatewayUrl":"https://example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.resources","status":"start","message":"Preparing the app's resources..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.resources","status":"ok","message":"The app's resources are ready."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.install","status":"start","message":"Installing dependencies..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.install","status":"ok"}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.build","status":"start","message":"Building..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.build","status":"ok","message":"Built the app and checked its Workers.","data":{"release":false,"workflows":[]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"warning","code":"SCHEMA_CHECK_SKIPPED","step":"app.schema","message":"Can't check the schema against the migrations: drizzle-kit isn't installed","data":{"fix":"add drizzle-kit to devDependencies"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.migrations","status":"start","message":"Migrating the Postgres database...","data":{"dialect":"postgresql","engine":"drizzle"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.migrations","status":"ok","message":"Migrated the app's Postgres database (drizzle-kit migrate).","data":{"dialect":"postgresql","engine":"drizzle"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.helper","status":"start","message":"Uploading every-acme-seo--audit...","data":{"name":"audit","workerName":"every-acme-seo--audit"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.helper","status":"ok","message":"Uploaded every-acme-seo--audit.","data":{"name":"audit","workerName":"every-acme-seo--audit"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.upload","status":"start","message":"Uploading every-acme-seo..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.upload","status":"ok","message":"Uploaded version every-acme-seo-version-18.","data":{"versionId":"every-acme-seo-version-18"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.live","status":"ok","message":"seo is live at https://seo.example.com.","data":{"hostname":"seo.example.com","url":"https://seo.example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.delete","status":"start","message":"Removing seo from the Gateway...","data":{"appId":"seo"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"gateway.deploy","status":"start","message":"Uploading Gateway 0.2.0 with 0 apps","data":{"appWorkers":[],"domains":["example.com"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"gateway.deploy","status":"ok","message":"Uploaded version every-app-gateway-version-20","data":{"versionId":"every-app-gateway-version-20"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.delete","status":"ok","message":"seo is deleted on the gateway; seo.example.com stops serving it.","data":{"appId":"seo","hostname":"seo.example.com","workerName":"every-acme-seo","alreadyDeleted":false}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.certificate","status":"ok","message":"Removed seo.example.com's certificate.","data":{"hostname":"seo.example.com","certificatePacks":["pack-15"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.purge","status":"start","message":"Deleting seo's Worker and data...","data":{"appId":"seo"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.purge","status":"ok","message":"Deleted Worker \"every-acme-seo\", Worker \"every-acme-seo--audit\", Hyperdrive config \"every-acme-seo--hyperdrive\", KV namespace \"every-acme-seo\".","data":{"appId":"seo","removed":["Worker \"every-acme-seo\"","Worker \"every-acme-seo--audit\"","Hyperdrive config \"every-acme-seo--hyperdrive\"","KV namespace \"every-acme-seo\""],"kinds":["2 Workers","KV namespace","Hyperdrive config"]}}

## uploads

### every-acme-seo--audit (text; secrets EVERY_APP_ORG_ID,GATEWAY_URL)
{
  "name": "every-acme-seo--audit",
  "compatibilityDate": "2026-06-01",
  "compatibilityFlags": [
    "nodejs_compat"
  ],
  "workersDev": false,
  "previewUrls": false,
  "placement": {
    "region": "aws:us-east-1"
  },
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
      "value": "seo"
    },
    "KV": {
      "type": "kv",
      "id": "00000000000000000000000000000007"
    },
    "EVERY_APP_GATEWAY": {
      "type": "worker",
      "worker": "every-app-gateway",
      "exportName": "AppGateway",
      "props": {
        "organizationId": "<uuid-1>",
        "appId": "seo",
        "workerName": "every-acme-seo"
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
      "value": "postgres"
    },
    "HYPERDRIVE": {
      "type": "hyperdrive",
      "id": "00000000000000000000000000000008"
    }
  },
  "exports": {},
  "manifest": {
    "type": "partial",
    "mainModule": "index.js",
    "modules": {}
  }
}
### every-acme-seo (text; secrets EVERY_APP_ORG_ID,GATEWAY_URL)
{
  "name": "every-acme-seo",
  "compatibilityDate": "2026-06-01",
  "compatibilityFlags": [
    "nodejs_compat"
  ],
  "workersDev": false,
  "previewUrls": false,
  "placement": {
    "region": "aws:us-east-1"
  },
  "limits": {
    "cpuMs": 30000
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
      "value": "seo"
    },
    "EVERYAPP_MANIFEST": {
      "type": "json",
      "value": {
        "id": "seo",
        "resources": {
          "kv": [
            "KV"
          ],
          "hyperdrive": [
            {
              "name": "HYPERDRIVE"
            }
          ]
        },
        "workers": [
          {
            "name": "audit",
            "binding": "AUDIT_ENGINE",
            "limits": {
              "cpuMs": 300000
            }
          }
        ],
        "database": {
          "provider": "postgres",
          "region": "aws:us-east-1"
        },
        "limits": {
          "cpuMs": 30000
        },
        "migrations": {
          "engine": "drizzle",
          "dialect": "postgresql",
          "dir": "drizzle/pg",
          "config": "drizzle/pg.config.ts"
        }
      }
    },
    "CF_VERSION_METADATA": {
      "type": "version-metadata"
    },
    "EVERYAPP_AUDIENCE": {
      "type": "text",
      "value": "every-acme-seo"
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
        "appId": "seo",
        "workerName": "every-acme-seo"
      }
    },
    "GATEWAY_URL": {
      "type": "secret"
    },
    "EVERY_APP_ORG_ID": {
      "type": "secret"
    },
    "KV": {
      "type": "kv",
      "id": "00000000000000000000000000000007"
    },
    "DATABASE_PROVIDER": {
      "type": "text",
      "value": "postgres"
    },
    "HYPERDRIVE": {
      "type": "hyperdrive",
      "id": "00000000000000000000000000000008"
    },
    "AUDIT_ENGINE": {
      "type": "worker",
      "worker": "every-acme-seo--audit"
    }
  },
  "exports": {},
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
    "EVERYAPP_GATEWAY_NAME": {
      "type": "text",
      "value": ""
    },
    "APP__every-acme-seo": {
      "type": "worker",
      "worker": "every-acme-seo"
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
    "seo.example.com"
  ]
}
### every-acme-seo--audit (text; secrets EVERY_APP_ORG_ID,GATEWAY_URL)
{
  "name": "every-acme-seo--audit",
  "compatibilityDate": "2026-06-01",
  "compatibilityFlags": [
    "nodejs_compat"
  ],
  "workersDev": false,
  "previewUrls": false,
  "placement": {
    "region": "aws:us-east-1"
  },
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
      "value": "seo"
    },
    "KV": {
      "type": "kv",
      "id": "00000000000000000000000000000007"
    },
    "EVERY_APP_GATEWAY": {
      "type": "worker",
      "worker": "every-app-gateway",
      "exportName": "AppGateway",
      "props": {
        "organizationId": "<uuid-1>",
        "appId": "seo",
        "workerName": "every-acme-seo"
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
      "value": "postgres"
    },
    "HYPERDRIVE": {
      "type": "hyperdrive",
      "id": "00000000000000000000000000000008"
    }
  },
  "exports": {},
  "manifest": {
    "type": "partial",
    "mainModule": "index.js",
    "modules": {}
  }
}
### every-acme-seo (text; secrets EVERY_APP_ORG_ID,GATEWAY_URL)
{
  "name": "every-acme-seo",
  "compatibilityDate": "2026-06-01",
  "compatibilityFlags": [
    "nodejs_compat"
  ],
  "workersDev": false,
  "previewUrls": false,
  "placement": {
    "region": "aws:us-east-1"
  },
  "limits": {
    "cpuMs": 30000
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
      "value": "seo"
    },
    "EVERYAPP_MANIFEST": {
      "type": "json",
      "value": {
        "id": "seo",
        "resources": {
          "kv": [
            "KV"
          ],
          "hyperdrive": [
            {
              "name": "HYPERDRIVE"
            }
          ]
        },
        "workers": [
          {
            "name": "audit",
            "binding": "AUDIT_ENGINE",
            "limits": {
              "cpuMs": 300000
            }
          }
        ],
        "database": {
          "provider": "postgres",
          "region": "aws:us-east-1"
        },
        "limits": {
          "cpuMs": 30000
        },
        "migrations": {
          "engine": "drizzle",
          "dialect": "postgresql",
          "dir": "drizzle/pg",
          "config": "drizzle/pg.config.ts"
        }
      }
    },
    "CF_VERSION_METADATA": {
      "type": "version-metadata"
    },
    "EVERYAPP_AUDIENCE": {
      "type": "text",
      "value": "every-acme-seo"
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
        "appId": "seo",
        "workerName": "every-acme-seo"
      }
    },
    "GATEWAY_URL": {
      "type": "secret"
    },
    "EVERY_APP_ORG_ID": {
      "type": "secret"
    },
    "KV": {
      "type": "kv",
      "id": "00000000000000000000000000000007"
    },
    "DATABASE_PROVIDER": {
      "type": "text",
      "value": "postgres"
    },
    "HYPERDRIVE": {
      "type": "hyperdrive",
      "id": "00000000000000000000000000000008"
    },
    "AUDIT_ENGINE": {
      "type": "worker",
      "worker": "every-acme-seo--audit"
    }
  },
  "exports": {},
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
    "EVERYAPP_GATEWAY_NAME": {
      "type": "text",
      "value": ""
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
account json cf d1 list --name every-app-gateway --per-page 100 --page 1
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
account json cf dns records list -z zone-1 --name-exact seo.example.com --per-page 100
account json cf dns records list -z zone-1 --name-exact *.example.com --per-page 100
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-seo --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-seo--audit --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf kv namespaces list --per-page 100 --page 1
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf kv namespaces create --title every-acme-seo
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf hyperdrive list --per-page 20 --page 1
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf hyperdrive create --body @/fake-cf-files/hyperdrive.json files=hyperdrive.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
project text cf build cwd=<app>
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-seo --per-page 10
account json cf workers deployments list --worker every-acme-seo--audit --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-seo--audit --per-page 10
project text cf deploy --prebuilt --no-provision --mode production --message everyapp 0.3.0 seo audit --worker every-acme-seo--audit --secrets-file /fake-cf-files/secrets.json files=secrets.json cwd=<app>
account json cf workers deployments list --worker every-acme-seo--audit --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-seo --per-page 10
project text cf deploy --prebuilt --no-provision --mode production --message everyapp 0.3.0 seo --secrets-file /fake-cf-files/secrets.json files=secrets.json cwd=<app>
account json cf workers deployments list --worker every-acme-seo --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers secrets list --worker every-acme-seo
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
account json cf workers deployments list --worker every-acme-seo --per-page 10
account json cf dns records list -z zone-1 --name-exact seo.example.com --per-page 100
account json cf dns records list -z zone-1 --name-exact *.example.com --per-page 100
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-app-gateway --per-page 10
project text cf deploy --prebuilt --no-provision --mode production --message everyapp 0.3.0 gateway 0.2.0 (reconcile) cwd=<home>/.everyapp/cf/tmp/gateway-deploy-<tmp>
account json cf workers deployments list --worker every-app-gateway --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf queues list
account json cf queues messages push queue-00000003 --body @/fake-cf-files/body.json files=body.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf zero-trust access applications list --per-page 100 --page 1
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf auth whoami
account json cf d1 list --name every-app-gateway --per-page 100 --page 1
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
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf kv namespaces list --per-page 100 --page 1
account json cf hyperdrive list --per-page 20 --page 1
project text cf build cwd=<app>
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-seo --per-page 10
account json cf workers deployments list --worker every-acme-seo--audit --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-seo--audit --per-page 10
project text cf deploy --prebuilt --no-provision --mode production --message everyapp 0.3.0 seo audit --worker every-acme-seo--audit --secrets-file /fake-cf-files/secrets.json files=secrets.json cwd=<app>
account json cf workers deployments list --worker every-acme-seo--audit --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-seo --per-page 10
project text cf deploy --prebuilt --no-provision --mode production --message everyapp 0.3.0 seo --secrets-file /fake-cf-files/secrets.json files=secrets.json cwd=<app>
account json cf workers deployments list --worker every-acme-seo --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers secrets list --worker every-acme-seo
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf queues list
account json cf queues messages push queue-00000003 --body @/fake-cf-files/body.json files=body.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf zero-trust access applications list --per-page 100 --page 1
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf auth whoami
account json cf d1 list --name every-app-gateway --per-page 100 --page 1
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
account json cf ssl certificate-packs delete pack-15 -z zone-1 --force
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workflows list --search every-acme-seo --per-page 100 --page 1
account json cf workers deployments list --worker every-acme-seo --per-page 10
account json cf workers delete every-acme-seo --force
account json cf workers deployments list --worker every-acme-seo--audit --per-page 10
account json cf workers delete every-acme-seo--audit --force
account json cf hyperdrive delete 00000000000000000000000000000008 --force
account json cf kv namespaces delete 00000000000000000000000000000007 --force
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf r2 buckets list --name-contains every-acme-seo --per-page 100
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json

## ledger after the first deploy

hyperdrive "HYPERDRIVE" every-acme-seo--hyperdrive 00000000000000000000000000000008 null
kv "KV" every-acme-seo 00000000000000000000000000000007 null
worker "" every-acme-seo every-acme-seo every-acme-seo-version-11
worker "audit" every-acme-seo--audit every-acme-seo--audit every-acme-seo--audit-version-9

## ledger after the redeploy

hyperdrive "HYPERDRIVE" every-acme-seo--hyperdrive 00000000000000000000000000000008 null
kv "KV" every-acme-seo 00000000000000000000000000000007 null
worker "" every-acme-seo every-acme-seo every-acme-seo-version-18
worker "audit" every-acme-seo--audit every-acme-seo--audit every-acme-seo--audit-version-16

## ledger after the purge


