// vitest aliases "electron" here: unit tests must run headless (CI on Linux), so anything that
// pulls Electron into a test fails loudly instead of trying to launch it.
throw new Error("A unit test imported 'electron'. Keep Electron out of tested modules (src/main/index.ts wires it).");
