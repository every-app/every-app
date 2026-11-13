# The Worker holds no manifest

Date: 2026-11-13. Status: **built in this change.** Ben's decision, the same day, over the first version of this note (which kept the binding and shrank it): "let's redo it from first principles so that the worker doesn't carry these manifests at all."

## The rule

1. The Gateway's registry is the only home of an app's manifest. A Worker built with the SDK after 0.3.3 has no `EVERYAPP_MANIFEST` binding, deployed or under `everyapp dev`, so the size of `everyapp.config.ts` can never fail an install.
2. A fact the code needs at run time is written in the code: a model id, the app's name. The Worker still gets its id (`env.EVERYAPP_APP_ID`) and the bindings the manifest lists.
3. A build made with an older SDK declares the binding and reads it, so the installers keep filling it for such a build, and only for such a build. That is a shim with an end (below).

## The problem

`everyapp install` of Sink 0.3.1 on everyapp.team failed at the Worker upload, after the release was checked and the database created:

```
✗ [10054] Text binding 'EVERYAPP_MANIFEST' is too large, its size of 7.1 kB exceeds the limit of 5.1 kB.
```

Every installer wrote the whole manifest into the app's Worker as one JSON variable, `env.EVERYAPP_MANIFEST`. Cloudflare caps one variable at 5 KB. Sink's manifest is 7,083 bytes as JSON, because it declares 17 settings and 10 features, each with a sentence of `why` and its setup `steps`. Nothing checked the size before the upload.

## What the Worker's copy was for

The Gateway's registry holds the manifest that counts. The Gateway decides from it which models, capabilities, public routes and events the app gets, and its admin pages show the settings, features and reasons. The Worker's copy grants nothing.

The copy existed because the Worker can't import `everyapp.config.ts` (the Cloudflare Vite plugin hides every file `cloudflare.config.ts` imports), and an app sometimes wants to read what it declared. Everything that read it before this change:

| Reader | What it reads |
| --- | --- |
| The SDK at run time | Nothing. It only declares the binding and its type. |
| The starter's first screen (`starter/src/serverFunctions/home.ts`) | `name`, `id`, and the names in `resources`, `public`, `providers`, `capabilities`, `secrets`. |
| Scribe (`private-open-scribe`, `web/src/server/notes.ts`) | `ai.models[0]`. |
| OpenMail, OpenCRM, OpenAnalytics, Links, Mission Control, Sink | Nothing. |

Nobody reads `why`, `how`, `docs` or `steps` in a Worker. That text is written for the person who installs the app, and the Gateway shows it from the registry. In Sink it is 3,440 of the 7,083 bytes.

The copy could also drift: the CLI writes the release's own manifest into the binding, while the Gateway's browser install and the hosted deployer write the registry's. Both come from the same validated file in one install, so they agree in practice, but only the registry is checked on every request.

## Cloudflare's limits

From <https://developers.cloudflare.com/workers/platform/limits/>, read 2026-11-13:

| Limit | Free | Paid |
| --- | --- | --- |
| Variable size | 5 KB | 5 KB |
| Variables per Worker (secrets + text) | 64 | 128 |
| Worker size | 64 MiB uncompressed, no compressed limit | same |
| Static asset files per version | 20,000 | 100,000 |
| One static asset | 25 MiB | 25 MiB |
| Startup time | 1 second | 1 second |

- The page states no limit on the number of bindings of other kinds, on the total size of the upload's metadata, or on a service binding's `props`.
- The 5 KB applies to JSON variables too: the refused binding was sent as `json`, and the error calls it a text binding.
- Cloudflare measures compact UTF-8 JSON, and the limit is 5 KiB. Sink's manifest is 7,083 bytes compact, reported as "7.1 kB", against "5.1 kB" (5,120 bytes).
- The upload API (<https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/>) has binding kinds that carry more (`data_blob`, `text_blob`), but they are deprecated and "only accepted for service worker syntax Workers". App Workers are ES modules.

## What else grows with the app

| What | Grows with | Limit | Distance |
| --- | --- | --- | --- |
| `EVERYAPP_MANIFEST` | Everything in the manifest | 5 KB | Hit. |
| The Worker's variables | Each secret and each setting is one, beside about seven of the platform's | 64 Free, 128 Paid | Sink: about 35. The next one an app could hit. Not handled here. |
| `EVERYAPP_IDENTITY_PUBLIC_KEYS` | The Gateway's keys, not the app | 5 KB | One key is about 450 bytes. |
| The Gateway binding's `props` | Nothing: three ids | None stated | Far. |
| The tool catalog | The app's tools | None: the Gateway fetches it from the app, it is not a binding | Not a deploy limit. |
| Bundle and assets | The app's code | 64 MiB, 20,000 files | Sink: 12 MB unpacked. |

The manifest binding was the only thing in the upload that grows with what an author writes in `everyapp.config.ts` and has a small limit.

## The options

| Option | Old SDKs and published releases | What it costs |
| --- | --- | --- |
| **A. No manifest in the Worker.** The registry is the one copy; the code holds the few facts it needs. **Chosen.** | An old build reads `env.EVERYAPP_MANIFEST` synchronously, so it needs the shim below to keep working. | An SDK release, and each app that reads the binding changes a line when it moves to that SDK. |
| **A′. A plus an SDK call that asks the Gateway for the manifest.** | As A. | A new route on the AppGateway entrypoint, a security review, and a fallback under `everyapp dev`, where there is no Gateway: the manifest would be back in a dev binding. Nothing needs it today. Not built. |
| **B. The manifest as a module in the bundle,** with an SDK `manifest()` that imports it. | Unchanged, so still over the limit. | An SDK release and a rebuilt release. The installer starts writing modules, which it never does today, and for a hosted app the module must be the registry's copy. A second copy stays. |
| **C. Split or compress across several variables,** reassembled by the SDK. | Old code sees a fragment or a string. | An SDK release and a rebuilt release. Spends variables, of which a Worker has 64. A second copy stays. |
| **D. Wrap the app's entry module** so the installer can patch `env`. | Would work without a rebuild. | The installer rewrites third-party code, and `import { env } from "cloudflare:workers"`, which the starter uses, is still not patched. Rejected. |
| **E. Keep the binding, bounded:** whole when it fits, else without its setup text. | Works with no rebuild. | The copy stays, with a size cliff and a limit that remains. Kept only as the shim. |

## Why A

- The copy grants nothing and almost nobody reads it (the table above). It is a second source of truth whose only effect so far has been to fail an install.
- It removes the class of problem. With no binding, nothing in the upload grows with what an author writes in `everyapp.config.ts`.
- The two readers need one fact each. A model id and a name are the code's own knowledge; they don't need the document.
- A′ stays open and is additive: if an app ever needs the whole manifest at run time, the Gateway can answer for it over the binding it already has.

## What an app does instead

| Reader | Before | After |
| --- | --- | --- |
| The starter (`starter/src/serverFunctions/home.ts`) | `name` and the manifest's lists, for the first screen | The name is made from `env.EVERYAPP_APP_ID`, which is what `everyapp create` names an app after. The screen lists what the code knows: its tools and the `members` call. |
| Scribe (`private-open-scribe`, `web/src/server/notes.ts`, `notesModel()`) | `env.EVERYAPP_MANIFEST.ai?.models?.[0]` | A constant in that file, equal to the first of `ai.models` in its `everyapp.config.ts`. A unit test can import both and hold them equal. Its test mock (`web/src/server/apiRoutes.test.ts`) drops the key. |
| Everything else | Nothing | Nothing. |

The Worker can't share a module with `everyapp.config.ts` (the Vite plugin hides it in dev), so the constant is written twice. That is one line, and the Gateway refuses a model the manifest doesn't list, so a mismatch shows on the first call.

## The migration

The installers key off the build, not off a version. A built Worker (`worker.config.json`) either declares `EVERYAPP_MANIFEST` or it doesn't.

| What is installed | What happens |
| --- | --- |
| A release or a checkout built with SDK 0.3.3 or earlier (it declares the binding) | The installer fills it, through `workerManifest()` (`packages/perimeter/src/manifest/workerManifest.ts`): the manifest whole when it is at most 5,000 bytes as compact JSON, else without its setup text (`why`, `how`, `docs`, a feature's `steps`). Sink 0.3.1 goes from 7,083 to 3,643 bytes and installs as published. Nothing live changes on its next deploy. |
| The same, with a manifest over 5,000 bytes even without its setup text | Refused, with "rebuild the app with a newer @every-app/sdk". For a release, before anything is claimed or created (`installApp` reads the build first); for the hosted deployer, with the bundle's other problems. A build from source is checked once it exists, after its resources: it is refused then, and the retry reuses them. |
| An app rebuilt with the new SDK (it declares no binding) | No binding, on any installer, at any manifest size. Code that still reads `env.EVERYAPP_MANIFEST` fails its typecheck: `cf workers types` no longer writes the key. |
| `everyapp dev` | The same as a deploy: the binding comes from `everyAppWorker()`, so the new SDK gives none and an old one gives the whole manifest (there is no limit locally). |
| A new-SDK app on a Gateway or CLI from before this change | Works. The browser install and the CLI only ever wrote the bindings a build declares. The hosted deployer of an older Gateway adds the binding anyway, which the Worker ignores. |

The three places that fill the binding for an old build:

| Path | Where | Whose manifest |
| --- | --- | --- |
| `everyapp deploy`, `everyapp install` (the CLI, through `cf`) | `installWorkerConfig` (`packages/perimeter/src/install/config.ts`) | The build's or the release's |
| Admin → Apps → Install app (the Gateway, REST) | `selfHostedMetadata` | The registry's |
| The hosted deployer | `userWorkerBindings` (`metadata.ts`) | The registry's |

### When the shim goes

When no installed app's Worker declares `EVERYAPP_MANIFEST`. To tell: a Worker's bindings, as Cloudflare lists them (the Worker's Settings → Bindings in the dashboard, or `GET /accounts/<account>/workers/scripts/<worker>/settings`), hold a JSON binding of that name exactly when its build declared one. First-party apps drop it on their first deploy with the new SDK. A third-party release drops it when its publisher rebuilds.

Deleting the shim is: `workerManifest.ts` and its test, `installManifestBinding` in `config.ts`, the check at the top of `installApp`, the `EVERYAPP_MANIFEST` case in `selfHostedMetadata`, and the manifest lines of `bundleProblems` and `userWorkerBindings`. After that an old build's binding is installed as the build wrote it, or refused by the hosted policy as an unknown variable.

## What it breaks, and what it leaves

- **An app that moves to the new SDK and reads `env.EVERYAPP_MANIFEST`** stops compiling until the read is replaced. Scribe is the one first-party app.
- **`EveryAppEnv`** loses the key and its type parameter. No first-party app passed one.
- **The starter's first screen** no longer lists the manifest's resources, public routes, providers and secrets. It says the Gateway keeps that file.
- **An old build over 5 KB** reads no setup text from `env` once deployed. Nobody does.
- **The variable count** (64 Free, 128 Paid) is not handled. An app with more secrets and settings than that fails at the upload as before.

## The failed install

Read from the code, not from the live Gateway. The CLI's install stopped at the upload, after it had registered Sink (status `pending`), claimed its Worker name, created its D1 database and recorded it as Sink's in the resource ledger, and applied six migrations. No Worker was uploaded and the app's lease was released.

A second `everyapp install`, with a CLI that has this change, picks all of that up: the app is found by id and its deploy is still its first (`NEVER_LIVE`), the database is found in the ledger and reused, no migration is pending, and the upload goes ahead. Nothing needs cleaning up first.
