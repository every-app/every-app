# The Gateway's release is saved in its own account

Date: 2026-11-14. Status: **built in this change.** Ben's decision, the same day: "D is a good idea", and R2 over KV.

## The problem

`everyapp deploy` of a new app, `delete`, and a new hostname all re-upload the Gateway, to change which apps it binds. They never change its code, so they need the exact release that is live (`lib/gateway/liveRelease.ts`). For a Gateway deployed from a checkout (everyapp.team, demo.everyapp.dev) that build exists only in the build cache of the machine that last ran `update`. Everywhere else the deploy stops with `GATEWAY_RELEASE_UNAVAILABLE`.

Cloudflare has no way to add a binding to a Worker without uploading its code through `cf`, and `cf` has no command that downloads a Worker's modules.

## The rule

Every deploy of the Gateway saves the release it deploys in an R2 bucket of the Gateway's own Cloudflare account. A rebind takes the live release from there first, on any machine, and falls back to the older rules when it isn't there.

## What is saved, and where

| | |
| --- | --- |
| Bucket | `every-app-gateway--releases` (`every-app-gateway-<name>--releases` for a named Gateway): `GatewayNames.releases`. The `--` keeps it from ever being another Gateway's name. Default jurisdiction, private: no public URL is ever turned on. |
| Who creates it | The CLI, on the first save (`lib/gateway/releaseStore.ts`). Setup and update already stop on an account without R2 (#1099). |
| Object | One per release: the release tarball exactly as it was deployed (`every-app-gateway-release.tar.gz`: the prebuilt Build Output, the migrations, `release.json`). About 10 MB. |
| Key | `<release SHA-256>.tar.gz`, the SHA-256 the install row records (`release_sha256`): the hash over the release's files, not over the tarball's bytes. No slash in a key, because `cf` percent-encodes one. |
| Metadata | None. `cf r2 objects put` can set none, and none is needed: the key says which release it is, and the content proves it. |

One archive, not the module set: it is the format every other source of a release already has, so the rebind opens it with the code that opens a download.

## Which release is live

The install row in the Gateway's D1 (`_everyapp_install.release_sha256`) is the one record of what is live, as before. The CLI reads it through `cf`, lists the bucket, and downloads `<that SHA-256>.tar.gz`.

What comes back is opened like any release: no links, no module outside its bundle, and its files must hash to the SHA-256 its `release.json` records. The rebind then requires that SHA-256 and the version to be the row's. `release.json` itself is not part of the hash, so the order the next row records is the current row's, never the object's.

When R2 and the row disagree:

| R2 has | What happens |
| --- | --- |
| No object for the row's SHA-256 (a Gateway last updated by an everyapp before this, a failed save) | The older rules: the GitHub release by tag, the URL or file, the checkout's build cache, a build of the same sources. If none works, `GATEWAY_RELEASE_UNAVAILABLE`, which now says that one `everyapp update` fixes it for every machine. |
| An object that is damaged, or isn't that release | It is never deployed. The older rules, then the same refusal. |
| Objects the row doesn't name | Ignored, and removed by retention. |

A rebind that takes the release from R2 deploys the exact bytes that are live. Before, a checkout whose sources matched built them again, which is the same Gateway in other bytes.

## When it is saved

In `applyGateway`, before the upload, for every deploy of the Gateway (install, update, repair, and a rebind whose release came from somewhere other than R2). Before, not after: `cf` can stop after the upload, with the install row already naming the new release, and the object must be there whenever the row names it. A save for an upload that then fails leaves one extra object, which retention removes.

`update` and `setup` on a Gateway that is already up to date deploy nothing, so they check that the live release is saved and save it if this machine has those exact bytes. If it has only another build of the same sources, they say so: `everyapp update --redeploy` deploys that build and saves it.

## Retention

After a successful upload: the live release and the two saved most recently besides it stay; the rest are deleted. At most three objects, about 30 MB, well inside R2's free 10 GB. The two others are there for an update that stopped halfway (the row still names the previous release) and for an update that finishes while another machine's deploy is in flight. Only keys shaped `<64 hex>.tar.gz` are ever read or deleted; anything else a person puts in the bucket is left alone.

Teardown empties the bucket of its releases and deletes it.

## What is in the bundle

The Gateway's built code and client assets, its migrations and `release.json` (version, commit, build time, hashes). It is the release before it is patched for an install: no account id, no D1 or KV id, no hostname, no app. Secrets never enter a release (the builder refuses local state and secret files), and the identity key pair goes to the Worker as secrets, at the upload.

For a Gateway from a published release the object is what is public on GitHub. For one built from a checkout it is the build of that checkout's source, which is private for this repository; it sits in the same account that runs it as a Worker, readable by the same people and tokens that can already download the Worker. That is acceptable.

Writing to the bucket gives no way to change the Gateway's code: an object is deployed only if its files hash to the SHA-256 in the install row, and whoever can write that row can already deploy the Worker.

## A save that fails

A warning (`GATEWAY_RELEASE_NOT_SAVED`), shown without `--verbose`, and the update goes on and succeeds. The Gateway that went live is right either way; what is lost is only that a new app's deploy from another machine falls back to the older rules. Failing the update for it would stop a good upgrade over a convenience, and saying nothing would leave the next person with `GATEWAY_RELEASE_UNAVAILABLE` and no reason. The warning names Cloudflare's reason and the command that tries again (`everyapp update`).

A rebind that can't read R2 (no permission, R2 off) treats the release as not saved and uses the older rules.

## Hosted Gateways and published releases

Unchanged in what they need: a Gateway from a GitHub release was always fetchable again by tag. They get the saved copy too, since every update saves, so a rebind no longer depends on GitHub answering or on the tag still being there. The hosted deployer doesn't use this code path and is not changed.

## Not checked

`cf r2 objects list/put/get/delete` were run against cf 1.0.0-beta.14's local simulation, not a live account: the listing's shape, the missing-bucket error and a 10 MB upload through the API are unverified until a live run (`pnpm e2e`).
