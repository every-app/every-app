## events

{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.connect","status":"start","message":"Finding your Gateway..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.connect","status":"ok","data":{"gatewayUrl":"https://example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.deploy","status":"ok","message":"Deploying todo to https://example.com.","data":{"appId":"todo","organizationName":"Acme","firstDeploy":true,"gatewayUrl":"https://example.com","gatewayHost":"example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.register","status":"ok","message":"Registered todo as every-acme-todo at https://todo.example.com (pending).","data":{"appId":"todo","workerName":"every-acme-todo","hostname":"todo.example.com","status":"pending","existingApp":false,"firstDeploy":true,"defaultAccess":false,"deployerAccess":false,"hasOwner":false,"publicRoutes":[],"mcp":null,"scope":"org","organizationId":"<uuid-1>","organizationName":"Acme","gatewayUrl":"https://example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"warning","code":"CUSTOM_DOMAIN_OWNER_UNCHECKED","step":"app.domain","message":"If another Worker already serves todo.example.com, it will be replaced by this deployment.","data":{"hosts":["todo.example.com"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.resources","status":"start","message":"Preparing the app's resources..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"progress","step":"app.resources","message":"Created D1 database \"every-acme-todo\"."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"progress","step":"app.resources","message":"Created KV namespace \"every-acme-todo\"."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.resources","status":"ok","message":"The app's resources are ready."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.install","status":"start","message":"Installing dependencies..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.install","status":"ok"}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.build","status":"start","message":"Building..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.build","status":"ok","message":"Built the app and checked its Worker.","data":{"release":false,"workflows":["every-acme-todo--rank-check"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"warning","code":"SCHEMA_CHECK_SKIPPED","step":"app.schema","message":"Can't check the schema against the migrations: drizzle-kit isn't installed","data":{"fix":"add drizzle-kit to devDependencies"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.migrations","status":"start","message":"Migrating the database..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.migrations","status":"ok","message":"Applied 0000_init.sql.","data":{"applied":["0000_init.sql"],"fresh":true}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.upload","status":"start","message":"Uploading every-acme-todo..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.upload","status":"ok","message":"Uploaded version every-acme-todo-version-8.","data":{"versionId":"every-acme-todo-version-8"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.bind","status":"start","message":"Binding APP__every-acme-todo on the gateway and publishing its hostname...","data":{"appId":"todo"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"gateway.deploy","status":"start","message":"Uploading Gateway 0.2.0 with 1 app","data":{"appWorkers":["every-acme-todo"],"domains":["example.com","todo.example.com"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"gateway.deploy","status":"ok","message":"Uploaded version every-app-gateway-version-10","data":{"versionId":"every-app-gateway-version-10"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.bind","status":"ok","message":"The gateway binds APP__every-acme-todo (gateway version every-app-gateway-version-10).","data":{"versionId":"every-app-gateway-version-10","newHosts":["todo.example.com"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.live","status":"ok","message":"todo is live at https://todo.example.com.","data":{"hostname":"todo.example.com","url":"https://todo.example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.connect","status":"start","message":"Finding your Gateway..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.connect","status":"ok","data":{"gatewayUrl":"https://example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.deploy","status":"ok","message":"Deploying todo to https://example.com.","data":{"appId":"todo","organizationName":"Acme","firstDeploy":false,"gatewayUrl":"https://example.com","gatewayHost":"example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.register","status":"ok","message":"Updating todo as every-acme-todo at https://todo.example.com (active).","data":{"appId":"todo","workerName":"every-acme-todo","hostname":"todo.example.com","status":"active","existingApp":true,"firstDeploy":false,"defaultAccess":false,"deployerAccess":false,"hasOwner":false,"publicRoutes":[],"mcp":null,"scope":"org","organizationId":"<uuid-1>","organizationName":"Acme","gatewayUrl":"https://example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.resources","status":"start","message":"Preparing the app's resources..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.resources","status":"ok","message":"The app's resources are ready."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.install","status":"start","message":"Installing dependencies..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.install","status":"ok"}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.build","status":"start","message":"Building..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.build","status":"ok","message":"Built the app and checked its Worker.","data":{"release":false,"workflows":["every-acme-todo--rank-check"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"warning","code":"SCHEMA_CHECK_SKIPPED","step":"app.schema","message":"Can't check the schema against the migrations: drizzle-kit isn't installed","data":{"fix":"add drizzle-kit to devDependencies"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.migrations","status":"start","message":"Migrating the database..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.migrations","status":"ok","message":"The app's database is up to date.","data":{"applied":[],"fresh":false}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.upload","status":"start","message":"Uploading every-acme-todo..."}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.upload","status":"ok","message":"Uploaded version every-acme-todo-version-13.","data":{"versionId":"every-acme-todo-version-13"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.live","status":"ok","message":"todo is live at https://todo.example.com.","data":{"hostname":"todo.example.com","url":"https://todo.example.com"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.delete","status":"start","message":"Removing todo from the Gateway...","data":{"appId":"todo"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"gateway.deploy","status":"start","message":"Uploading Gateway 0.2.0 with 0 apps","data":{"appWorkers":[],"domains":["example.com"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"gateway.deploy","status":"ok","message":"Uploaded version every-app-gateway-version-15","data":{"versionId":"every-app-gateway-version-15"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.delete","status":"ok","message":"todo is deleted on the gateway; todo.example.com stops serving it.","data":{"appId":"todo","hostname":"todo.example.com","workerName":"every-acme-todo","alreadyDeleted":false}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.certificate","status":"ok","message":"Removed todo.example.com's certificate.","data":{"hostname":"todo.example.com","certificatePacks":["pack-12"]}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.purge","status":"start","message":"Deleting todo's Worker and data...","data":{"appId":"todo"}}
{"v":1,"ts":"1970-01-01T00:00:00.000Z","type":"step","step":"app.purge","status":"ok","message":"Deleted Workflow \"every-acme-todo--rank-check\", Worker \"every-acme-todo\", D1 database \"every-acme-todo\", KV namespace \"every-acme-todo\".","data":{"appId":"todo","removed":["Workflow \"every-acme-todo--rank-check\"","Worker \"every-acme-todo\"","D1 database \"every-acme-todo\"","KV namespace \"every-acme-todo\""],"kinds":["Worker","Workflow","D1 database","KV namespace"]}}

## uploads

### every-acme-todo (text; secrets EVERY_APP_ORG_ID,GATEWAY_URL)
{
  "name": "every-acme-todo",
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
      "value": "todo"
    },
    "CF_VERSION_METADATA": {
      "type": "version-metadata"
    },
    "EVERYAPP_AUDIENCE": {
      "type": "text",
      "value": "every-acme-todo"
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
        "appId": "todo",
        "workerName": "every-acme-todo"
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
      "name": "every-acme-todo",
      "id": "00000006-0000-4000-8000-000000000000"
    },
    "KV": {
      "type": "kv",
      "id": "00000000000000000000000000000007"
    },
    "USER_SYNC": {
      "type": "durable-object",
      "worker": "every-acme-todo",
      "exportName": "UserSyncDO"
    },
    "RANK_CHECK": {
      "type": "workflow",
      "name": "every-acme-todo--rank-check",
      "worker": "every-acme-todo",
      "exportName": "RankCheckWorkflow"
    }
  },
  "exports": {
    "UserSyncDO": {
      "type": "durable-object",
      "storage": "sqlite"
    },
    "RankCheckWorkflow": {
      "type": "workflow",
      "name": "every-acme-todo--rank-check"
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
    "APP__every-acme-todo": {
      "type": "worker",
      "worker": "every-acme-todo"
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
    "todo.example.com"
  ]
}
### every-acme-todo (text; secrets EVERY_APP_ORG_ID,GATEWAY_URL)
{
  "name": "every-acme-todo",
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
      "value": "todo"
    },
    "CF_VERSION_METADATA": {
      "type": "version-metadata"
    },
    "EVERYAPP_AUDIENCE": {
      "type": "text",
      "value": "every-acme-todo"
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
        "appId": "todo",
        "workerName": "every-acme-todo"
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
      "name": "every-acme-todo",
      "id": "00000006-0000-4000-8000-000000000000"
    },
    "KV": {
      "type": "kv",
      "id": "00000000000000000000000000000007"
    },
    "USER_SYNC": {
      "type": "durable-object",
      "worker": "every-acme-todo",
      "exportName": "UserSyncDO"
    },
    "RANK_CHECK": {
      "type": "workflow",
      "name": "every-acme-todo--rank-check",
      "worker": "every-acme-todo",
      "exportName": "RankCheckWorkflow"
    }
  },
  "exports": {
    "UserSyncDO": {
      "type": "durable-object",
      "storage": "sqlite"
    },
    "RankCheckWorkflow": {
      "type": "workflow",
      "name": "every-acme-todo--rank-check"
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
account json cf dns records list -z zone-1 --name-exact todo.example.com --per-page 100
account json cf dns records list -z zone-1 --name-exact *.example.com --per-page 100
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-todo --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 list --name every-acme-todo --per-page 100
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 create --name every-acme-todo
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf kv namespaces list --per-page 100 --page 1
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf kv namespaces create --title every-acme-todo
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
project text cf build cwd=<app>
account json cf workflows get every-acme-todo--rank-check
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-todo --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 migrations list 00000006-0000-4000-8000-000000000000 --dir <app>/drizzle
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 migrations apply 00000006-0000-4000-8000-000000000000 --dir <app>/drizzle
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-todo --per-page 10
project text cf deploy --prebuilt --no-provision --mode production --message everyapp 0.3.0 todo --secrets-file /fake-cf-files/secrets.json files=secrets.json cwd=<app>
account json cf workers deployments list --worker every-acme-todo --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers secrets list --worker every-acme-todo
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
account json cf workers deployments list --worker every-acme-todo --per-page 10
account json cf dns records list -z zone-1 --name-exact todo.example.com --per-page 100
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
account json cf d1 list --name every-acme-todo --per-page 100
account json cf kv namespaces list --per-page 100 --page 1
project text cf build cwd=<app>
account json cf workflows get every-acme-todo--rank-check
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-todo --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 migrations list 00000006-0000-4000-8000-000000000000 --dir <app>/drizzle
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers deployments list --worker every-acme-todo --per-page 10
project text cf deploy --prebuilt --no-provision --mode production --message everyapp 0.3.0 todo --secrets-file /fake-cf-files/secrets.json files=secrets.json cwd=<app>
account json cf workers deployments list --worker every-acme-todo --per-page 10
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workers secrets list --worker every-acme-todo
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
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
account json cf ssl certificate-packs delete pack-12 -z zone-1 --force
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf workflows list --search every-acme-todo --per-page 100 --page 1
account json cf workflows delete every-acme-todo--rank-check --force
account json cf workers deployments list --worker every-acme-todo --per-page 10
account json cf workers delete every-acme-todo --force
account json cf d1 delete 00000006-0000-4000-8000-000000000000 --force
account json cf kv namespaces delete 00000000000000000000000000000007 --force
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json
account json cf d1 query 00000001-0000-4000-8000-000000000000 --body @/fake-cf-files/query.json files=query.json

## ledger after the first deploy

d1 "DB" every-acme-todo 00000006-0000-4000-8000-000000000000 null
kv "KV" every-acme-todo 00000000000000000000000000000007 null
worker "" every-acme-todo every-acme-todo every-acme-todo-version-8

## ledger after the redeploy

d1 "DB" every-acme-todo 00000006-0000-4000-8000-000000000000 null
kv "KV" every-acme-todo 00000000000000000000000000000007 null
worker "" every-acme-todo every-acme-todo every-acme-todo-version-13

## ledger after the purge


