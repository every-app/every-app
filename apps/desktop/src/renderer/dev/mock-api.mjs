#!/usr/bin/env node
// The mock /api/v1 moved to e2e/mock-api.mjs (shared with the e2e smoke); this keeps the old
// command working:  node src/renderer/dev/mock-api.mjs   (PORT, default 8788)

import { startMockApi } from "../../../e2e/mock-api.mjs";

await startMockApi({ port: Number(process.env.PORT ?? 8788), log: console.log });
