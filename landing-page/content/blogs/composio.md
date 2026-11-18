---
title: "Composio in EveryApp: Connect all your accounts in one place"
description: "Turn on Composio and your apps can use all the accounts you connect there, with no OAuth app to set up."
author: "Carter Smith"
date: "2026-11-18"
draft: false
---

One of the most difficult parts of creating your own web apps has always been OAuth. Using OpenSEO as an example, if our app depends on connecting Google Search Console, we would need to create a Google Cloud project, fill out the configuration, pick scopes, and manage new secrets. This applies to every single integration.

In EveryApp, we want to make it simple for you and your agents to build and deploy apps that can integrate with any services. That's why we're adding support for [Composio](https://composio.dev); so your apps can use all the accounts that you connect in one place, with no configuration necessary.

## What Composio is

Composio is a service where you connect your accounts like Gmail, Calendar, Slack, GitHub, Notion, and hundreds more. Using it is a magical experience because you never set up authentication yourself. When one of your apps on EveryApp needs to use Gmail, it sends the request to Composio, and Composio uses your connection, so your apps never see a token or a key.

## How it works

- **An owner or admin turns Composio on** for the workspace.
- **Each user links their own Composio**, once.
- **Each app asks for permission.** The first time an app like OpenSEO needs access to Google, the Gateway asks: **Allow OpenSEO to use your Google account from Composio?** It shows the access it needs, like Search Console.
- **Connected apps just work.** Its code and its `everyapp.config.ts` don't change.

After being set up, accounts in Composio are like any other connection. It shows in **Your connections > Accounts**, every app asks for permission to use it, and you can disconnect it or manage access for specific apps.

## Set it up

An owner or admin must enable it first, either through **Manage workspace > Providers > Composio > Turn on**, or from a terminal:

```bash
everyapp workspace composio on
```

Then, individual users can link their own Composio, through **Your connections > Accounts > Link Composio**, or from a terminal:

```bash
everyapp provider link composio
```

This process will open Composio's sign-in page, wait for you to approve, then list your connected accounts that EveryApp can use.

Or let your agent do it. Copy this into Claude Code, Codex or Cursor:

```text
Turn on Composio for my EveryApp workspace and link my Composio account.
Docs: https://everyapp.com/docs/agent/setup/composio
```

There may be a few manual steps like approving the sign-in at Composio.

## What it covers

EveryApp can use these accounts from Composio: GitHub, Slack, Notion, Linear, GitLab, HubSpot, Zoom, Dropbox, Google Workspace, Microsoft 365 and Atlassian. We welcome requests to add more providers that Composio supports.

Each Google, Microsoft and Atlassian service (like email, calendar, and docs) is its own account in Composio. If an app needs a service you haven't connected, the Gateway's page will tell you which one and link to where you connect it in Composio. Connect it, then select **Check again**.

## The trade-off

Every request to the accounts you connect goes through Composio. If your data shouldn't pass through a third party, register the OAuth provider yourself.

You can still use an OAuth provider for specific services if you prefer. A provider is used one way: if the Gateway has an OAuth app for it, Composio is never used. For example, you can register Google yourself and use Composio for Slack and Linear. If you add your own OAuth app later, existing connections will need to be redone to move them over.

## Turning it off

To stop using Composio for one of your connected accounts, you can disable it in **Your connections > Accounts** by clicking **Disconnect** on that account. Every app using it will stop immediately.

To stop using Composio altogether, you can unlink it from the same page. Every connection you made through Composio will be removed.

An owner or admin can disable Composio for every user in a Gateway by selecting **Turn off** under **Manage workspace > Providers > Composio**, or running `everyapp workspace composio off`. Everyone's Composio link and every connection made through Composio will be removed.

We want to provide the best experience for you to create apps with all of your services. EveryApp is early, so expect some rough edges. If something is harder than it should be, tell us in [Discord](https://discord.gg/c9uGs3cFXr).
