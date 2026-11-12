---
title: The open apps
description: The open source apps EveryApp publishes, for an agent installing one for a person. Each app's id, repository, what it needs set, its public routes, who can open it, and whether it needs R2.
---

These apps run behind a Gateway as the person's own. The user page for each is under [/docs/apps](/docs/apps).

## Installing one

1. `everyapp install <repository URL> --json`, from any directory. It deploys the repository's latest release and registers the app under its id. `R2_NOT_ENABLED`: the person enables R2 once in the Cloudflare dashboard, then rerun. `NO_RELEASE`: the repository publishes no release; clone it and `everyapp deploy` from its directory. `RELEASE_INVALID` naming an older everyapp: the app needs a new release; tell the person, or clone it and `everyapp deploy`.
2. `everyapp configure <id>`: asks for every setting the app's manifest declares that isn't set, Gateway keys and the app's own, each where it belongs. `everyapp secret list <id>` shows exactly what the deployed manifest declares and what's set. [secrets](/docs/agent/secrets)
3. `everyapp status --json`: the app leaves **Needs setup** once its required settings are set.
4. To update, run the same `install` again. The deploy saves a restore point before migrating.

A Gateway key serves every app that lists it: one `OPENROUTER_API_KEY` or `EMAIL_FROM` covers them all. Each key has a setup guide ([setup/openrouter](/docs/agent/setup/openrouter), [setup/dataforseo](/docs/agent/setup/dataforseo), [setup/context](/docs/agent/setup/context), [setup/email](/docs/agent/setup/email), [setup/google](/docs/agent/setup/google), [setup/microsoft-365](/docs/agent/setup/microsoft-365)).

| id | Name | Repository | R2 | Who opens it after install |
|---|---|---|---|---|
| `openseo` | OpenSEO | https://github.com/every-app/open-seo | yes | every member |
| `crm` | OpenCRM | https://github.com/every-app/open-crm | yes | every member |
| `scribe` | OpenScribe | https://github.com/every-app/open-scribe | yes | every member |
| `analytics` | OpenAnalytics | https://github.com/every-app/open-analytics | no | every member |
| `openmail` | OpenMail | https://github.com/every-app/open-mail | yes | every member |
| `repolens` | RepoLens | not public yet | no | owners and admins |

## OpenSEO (`openseo`)

Keyword research, rank tracking and site audits. It needs an AI key (OpenRouter) and `DATAFORSEO_API_KEY` (the value is `login:password` from the DataForSEO dashboard). Context.dev (JavaScript-heavy pages) and Google (Search Console and GA4, connected per person) are optional. No public routes. Its tools are served on the Gateway's `/mcp` as `openseo_<tool>`.

## OpenCRM (`crm`)

Companies, contacts and deals, with mail, meetings and website visits filed on them. Nothing is required to open it. Optional: Google Workspace and Microsoft 365 clients so members can connect their mail and calendar (read only), with the app's own `TOKEN_ENCRYPTION_KEY` (32+ random characters) set before anyone connects. Public routes `GET /t/*` and `POST /t/e` serve website tracking on the organization's own site.

## OpenScribe (`scribe`)

AI meeting notes for Mac. In the app it is called Scribe, and its id is `scribe` (it was `talk`, which a Gateway that had it keeps serving). It needs an OpenAI key (`OPENAI_API_KEY`): it transcribes meetings and writes the notes. Google Calendar (`google-workspace`, `calendar.readonly`, connected per person) is optional, for meeting reminders. Meetings are recorded by Every App for Mac, which signs in with the Gateway's address or the app's URL (`https://scribe.<app base domain>`, or `https://talk.<app base domain>` on a Gateway that has it under the old id) and calls its bearer route `/api/v1/**`; `GET /s/:token` serves a shared meeting page.

## OpenAnalytics (`analytics`)

Web analytics on your own Cloudflare account, with no cookies. Nothing to set: the deploy generates the app's own `MAIN_SECRET` (changing it later splits visitor counts). The Gateway's sender (`EMAIL_FROM`) is optional, for emailed reports. Public routes serve the tracking script (`GET /script.js`), the collector (`POST /collect`) and shared dashboards (`/share/**`). The snippet is `<script defer src="https://analytics.<app base domain>/script.js?siteId=<id>"></script>`.

## OpenMail (`openmail`)

An email inbox with an AI assistant. It needs the workspace's default AI model and the Gateway's sender. After installing:

```sh
everyapp configure openmail
everyapp email set --sender '*@example.com' --inbound '*@example.com'
```

The second command routes the domain's mail to the app (a `*@` catch-all only on a zone's apex) and offers to turn Email Routing on. Each sending domain must be onboarded to Email Sending. [email](/docs/agent/email)

## RepoLens (`repolens`)

Keeps the GitHub traffic history GitHub drops after 14 days. Its repository isn't public yet: someone with access clones it, runs `pnpm install` and `everyapp deploy` in it, then `everyapp configure repolens`. It needs the app's own `GITHUB_TOKEN` (repo scope, or fine-grained Administration, Contents and Metadata read). Public route `GET /badge/*/*.svg`. It captures every six hours. A fresh install opens to the deployer, owners and admins; grant others in Admin → Apps.
