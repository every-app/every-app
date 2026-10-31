# Video script: Open source backlink outreach system with EveryApp

<!-- Draft for Ben. Built from the post at landing-page/content/blogs/open-source-backlink-outreach.md. Not recorded or published. -->

- **Format:** tutorial-style walkthrough (narrated-video skill, `references/formats.md`), on the demo Gateway https://demo.everyapp.dev, workspace "Ridgeline Digital".
- **Target:** about 4:00. 209 s planned on the cards; a take usually runs 15-25% long, so expect 4:00-4:20. Over 4:30: tighten scenes 4 and 8 first.
- **Story:** backlink outreach for Bramblewood Coffee. OpenSEO's backlinks show where competitors get links, Claude Code turns that into prospects and finds who to pitch, OpenCRM tracks each prospect on a list with stages, Claude Code writes the pitches in OpenMail and keeps the list up to date as replies come in. Then the Gateway underneath.
- **Captures:** 1440x900 at 2x with Playwright (`$SK/capture.mjs`), signed in as the demo owner. Terminal scenes are short screen recordings in a recording pane, cut to the finished state; never a real-time agent run.
- **Status:** the clicks use the real UI labels from the Gateway code (`Manage workspace`, `Use it from your agent`, the Admin tabs). Checked against the demo thread's checklist (first cut): OpenCRM, members, groups and providers are seeded. The demo is fully seeded (2026-10-31): OpenCRM lists and timelines, OpenMail replies with drafts and labels on the new UI, the OpenSEO project Bramblewood Coffee with saved keywords, OpenAnalytics traffic, and Usage and Activity from the day's tool calls. No scene waits on data.
- **Sign-in:** Access is on. Sign in through Cloudflare Access (Cloudflare login or one-time PIN) before recording, so every scene starts signed in as owner.
- **Demo data:** a "Backlink outreach" list of 10 fictional publications at Found (3), Contacted (2), Replied (2), Negotiating (1), Link live (1), Not interested (1), Due after 7 quiet days; a "Networking" list of 4 people. Deals are off. Members Ben (owner), Jonas Weber (admin), Priya Nair (member), Amara Okoye (invited). Groups Outreach and SEO research. OpenRouter and DataForSEO set; Granola has no key on the demo.

How to record (from the skill):

- One take, webcam and voice in one file (QuickTime: File > New Movie Recording).
- Talk from the bullets. The draft lines are there if you want them, not to read.
- Flubbed a line? Pause and say the sentence again. The edit keeps the clean one.
- Pause for a beat between scenes.
- Name what happens on screen as you say it ("Manage workspace", "Usage", "ten prospects"): the clicks and zooms land on those words.

---

## 1. Cold open (12 s)

- **On screen:** Claude Code finishing the outreach run, then the Backlink outreach board filling in. Take the frames from scene 4's recording.
- **Clicks:** none. Recording pane over the CRM; cut to the Backlink outreach board as the last tool call lands.
- **Say:**
  - My agent just found ten link prospects
  - Found who to email, put them in our CRM
  - Every app it used runs in my own Cloudflare account
- **Draft line:** "My agent just found ten link prospects, found who to email at each one, and put them all in our CRM. Every app it used runs in my own Cloudflare account. Here's how."
- **Tip:** this frame is the poster. Start on the whole CRM, no fade.

## 2. How backlinks work in OpenSEO (28 s)

- **On screen:** OpenSEO **Backlinks** for a competing roaster: the overview, then the **Referring Domains** tab.
- **Clicks:** open OpenSEO; type the competitor's domain into Backlinks (per keystroke as it's said); point at Backlinks and Referring Domains in the overview; click **Referring Domains**; pointer on the Spam column; zoom on one coffee publication.
- **Say:**
  - Best prospects: sites linking to competitors
  - Overview: backlinks, referring domains, spam
  - Referring Domains: one row per site
  - That's your target list; skip the spam
  - Pay per request, not per seat
- **Note:** the demo's competitor lookup is real data (onyxcoffeelab.com), so real sites show in Referring Domains. Fine on screen; the narration names none.
- **Draft line:** "The best link prospects are sites that already link to your competitors. In OpenSEO, put a competitor into Backlinks. Referring Domains groups their links by site, one row each. That's your target list. Skip anything spammy and keep the publications. You pay per request, so this costs cents, not a seat."

## 3. Connect Claude Code (14 s)

- **On screen:** the Gateway sidebar's **Connect your agent** dialog, on the **Claude Code** tab.
- **Clicks:** click **Connect your agent**; click **Claude Code**; zoom on the `claude mcp add` command.
- **Say:**
  - One MCP address for every app
  - Paste this into Claude Code
  - Pick the apps, read only or read & write
  - An agent can't delete anything
- **Draft line:** "Every app is behind one MCP address. Copy this command into Claude Code and sign in. You pick the apps and read only or read and write, and an agent can't delete anything."

## 4. Claude Code finds prospects and who to pitch (34 s)

- **On screen:** Claude Code in a terminal; the prompt typed, then its tool calls (`openseo_…` backlinks, then `crm_…`) scrolling, then the summary.
- **Clicks:** prompt typed as it's spoken; cut to the finished run.
- **Prompt on screen:** `Find sites that link to two of bramblewoodcoffee.com's competitors but not to Bramblewood. Pick the 10 best coffee publications, find the right person to pitch at each one, and add them to the Backlink outreach list in OpenCRM at Found.`
- **Say:**
  - Claude has the same backlink tools
  - Competitors' referring domains, minus spam
  - Finds the editor at each site
  - Adds them to the CRM
  - No copying between tabs
- **Draft line:** "This is the part I use most. Claude Code has the same backlink tools, so I ask for the whole job: sites that link to our client's competitors, the ten best publications, and the right person at each. It pulls the referring domains from OpenSEO, does the research, and adds them to OpenCRM. No copying between tabs."
- **Tip:** the longest scene; trims happen here.
- **Before recording:** run the prompt once against the demo in a recording pane and cut to the finished run. It spends DataForSEO credits and writes to the demo CRM; remove the ten new records afterwards if you want the seeded board back.

## 5. OpenCRM (20 s)

- **On screen:** Lists → **Backlink outreach** on **Board**; then Claude Code answering "Who on the Backlink outreach list is Due, and where did we leave each one?"; then The Daily Pour's sheet.
- **Clicks:** click **Backlink outreach** in the sidebar; click **Board**; pointer on a **Due** badge; cut to Claude Code, type the prompt, let the `crm_list_list_entries` call and the one-line-per-publication answer play; cut to The Daily Pour's sheet, pointer on the stage.
- **Say:**
  - A list with its own stages
  - Board: where every pitch stands
  - Due after seven quiet days
  - Ask Claude Code who's Due
  - Every move on the record's timeline
- **Draft line:** "In OpenCRM they land on a list. Backlink outreach has its own stages, and the board shows where every pitch stands. Anything quiet for seven days is marked Due, and I don't go looking for those. I ask Claude Code who's due and where we left each one."

## 6. OpenMail (24 s)

- **On screen:** Claude Code writing pitches to the editors at Found as drafts; the outreach@everyapp.cc inbox (three replies, labeled); Claude Code checking replies and moving publications to Replied; Maya's reply with OpenMail's draft under it.
- **Clicks:** in Claude Code, type "Write a short pitch to each editor on the Backlink outreach list at Found, from outreach@. Save them as drafts." (let the `agentic-inbox_create_draft` calls play); cut to OpenMail's inbox; back in Claude Code, type "Check outreach@ for replies to our pitches. Move each publication that replied to Replied, and tell me what each one asked for."; cut to Maya's reply, scroll to the draft, pointer rests on Send (don't send on camera).
- **Say:**
  - An inbox on your own domain, like Gmail
  - Claude Code writes the pitches as drafts
  - Replies come back here; it moves them to Replied
  - OpenMail drafts each answer; I hit send
- **Draft line:** "OpenMail is an inbox on our own domain. I have Claude Code write a pitch to every editor at Found, saved as drafts. When replies come in, it moves those publications to Replied and tells me what each one asked for. OpenMail's own agent has already drafted an answer, and nothing goes out until I hit send."
- **Before recording:** the pitch prompt writes drafts in the demo outreach mailbox (to the three Found editors) and the reply prompt moves list stages in the demo CRM. Delete the drafts and move the stages back afterwards.
- **Demo:** the overhauled OpenMail UI is deployed to the demo; labels and the Priya follow-up draft are seeded. Each new demo reply gets an auto-draft.

## 7. Keys live on the Gateway (18 s)

- **On screen:** **Manage workspace** → **Providers** (OpenRouter and DataForSEO set); then the command `everyapp provider add granola` typed in a terminal. The demo has no Granola key, so cut before the key prompt.
- **Clicks:** click **Manage workspace** in the sidebar footer; click **Providers**; pointer on OpenRouter and DataForSEO rows; cut to the terminal as it asks for the key (blank the key).
- **Say:**
  - Apps never see your keys
  - The Gateway makes the call
  - One command adds a provider, like Granola
  - One OpenRouter key, three apps
- **Draft line:** "Apps never hold your API keys. The Gateway makes the call for them. Adding a provider is one command, here Granola, and one OpenRouter key serves three apps at once."
- **Privacy:** no key value on screen, ever.

## 8. Running a team (22 s)

- **On screen:** **Users** (Ben, Jonas, Priya, Amara pending) → **Usage** with a monthly cap → **Activity** with Claude Code's calls.
- **Clicks:** click each tab as it's named; on Usage zoom on OpenSEO's **Monthly cap**; on Activity pointer on a `crm_` call from the outreach run.
- **Say:**
  - Invite people, member or admin; groups like Outreach
  - Usage: calls and cost per app, per person
  - Cap an app, it pauses, no surprise bill
  - Activity: every call my agent made
- **Before recording:** check OpenSEO has a monthly cap on Usage; set one if not, so the zoom has something to land on.
- **Draft line:** "Manage workspace is where I run the team. Invite people as members or admins. Usage shows calls and cost per app and per person, and a monthly cap pauses an app before it runs up a bill. Activity shows every tool call my agent just made."

## 9. Access and status (12 s)

- **On screen:** terminal: `everyapp status` output with every app live; then `everyapp access on` as one line.
- **Clicks:** none; type each command as it's said.
- **Say:**
  - Put Cloudflare Access in front
  - status: what's live, what to fix
  - My agent reads it and runs the fixes
- **Draft line:** "For a company, one command puts Cloudflare Access in front. And status says what's live and the exact command to fix anything, so my agent can keep it running."

## 10. Getting it running (17 s)

- **On screen:** the docs Get started block: `npm install -g everyapp`, `everyapp setup --domain …`; then `everyapp install https://github.com/every-app/open-seo`.
- **Clicks:** zoom on each command as it's said.
- **Say:**
  - Cloudflare Workers Paid, $5 a month
  - About fifteen minutes
  - Or paste one prompt into your agent
  - install any app from GitHub
- **Draft line:** "To set it up you need Cloudflare's five-dollar plan and a domain. It takes about fifteen minutes, or paste one prompt into your agent. Then install any of these apps from GitHub with one command."

## 11. End card (8 s)

- **On screen:** the EveryApp card (OG image), github.com/every-app/every-app.
- **Say:**
  - Thanks for watching
  - Early, rough edges, tell us in Discord
  - Star us on GitHub
- **Draft line:** "Thanks for watching. It's early, so tell us what's rough in Discord, and if you like it, give us a star on GitHub."

---

## storyboard.json

For `uv run $SK/storyboard.py storyboard.json storyboard/` once the captures exist. Image paths are placeholders until capture.

```json
{
  "title": "Open source backlink outreach system with EveryApp",
  "subtitle": "Backlink outreach with OpenSEO, Claude Code, OpenCRM and OpenMail, then the Gateway underneath. Record one take over these cards.",
  "target_seconds": 209,
  "notes": [
    "One take, webcam and voice together (QuickTime: File > New Movie Recording)",
    "Talk from the bullets; don't read them",
    "Flubbed a line? Pause and say the sentence again; the edit keeps the clean one",
    "Pause for a beat between cards",
    "Name what happens on screen as it happens: \"Manage workspace\", \"Usage\", \"ten prospects\""
  ],
  "cards": [
    {"title": "Cold open", "image": "shots/01-crm-list-board.png", "on_screen": "Claude Code finishing; the Backlink outreach board filling in", "seconds": 12, "say": ["My agent just found ten link prospects", "Found who to email, put them in our CRM", "All in my own Cloudflare account"], "tip": "This frame is the poster"},
    {"title": "How backlinks work in OpenSEO", "image": "shots/02-openseo-referring-domains.png", "on_screen": "Backlinks overview, then Referring Domains", "seconds": 28, "say": ["Sites linking to competitors", "Referring Domains: one row per site", "Your target list; skip the spam", "Pay per request"]},
    {"title": "Connect Claude Code", "image": "shots/03-connect-your-agent.png", "on_screen": "Connect your agent, Claude Code tab", "seconds": 14, "say": ["One MCP address", "Paste into Claude Code", "Can't delete anything"]},
    {"title": "Claude Code finds prospects and who to pitch", "image": "shots/04-claude-code.png", "on_screen": "The prompt, openseo_ and crm_ tool calls, the summary", "seconds": 34, "say": ["Same backlink tools", "Referring domains minus spam", "Editor at each site", "Into the CRM"], "tip": "The longest scene"},
    {"title": "OpenCRM", "image": "shots/05-crm-list-board.png", "on_screen": "Backlink outreach board, Claude Code listing who's Due, The Daily Pour", "seconds": 20, "say": ["A list with its own stages", "Due after 7 quiet days", "Ask Claude Code who's Due", "Moves on the timeline"]},
    {"title": "OpenMail", "image": "shots/06-openmail-reply.png", "on_screen": "Claude Code drafting pitches, the inbox, Claude Code moving replies to Replied, Maya's reply with the draft", "seconds": 24, "say": ["Inbox on your own domain", "Claude Code drafts the pitches", "Replies: moved to Replied", "OpenMail drafts, you hit send"]},
    {"title": "Keys on the Gateway", "image": "shots/08-providers.png", "on_screen": "Providers tab, then provider add granola", "seconds": 18, "say": ["Apps never see your keys", "One command adds Granola", "One OpenRouter key, three apps"]},
    {"title": "Running a team", "image": "shots/09-usage-cap.png", "on_screen": "Users, Usage with a cap, Activity", "seconds": 22, "say": ["Invite, member or admin", "Usage and caps", "Activity: every agent call"]},
    {"title": "Access and status", "image": "shots/10-status.png", "on_screen": "everyapp status, access on", "seconds": 12, "say": ["Access in front", "status: live, and what to fix", "Agent runs the fixes"]},
    {"title": "Getting it running", "image": "shots/11-get-started.png", "on_screen": "setup and install commands", "seconds": 17, "say": ["$5 a month plan and a domain", "About fifteen minutes", "Or one prompt", "install from GitHub"]},
    {"title": "Thanks", "image": "shots/14-og.png", "on_screen": "The EveryApp card", "seconds": 8, "say": ["Thanks for watching", "Early: tell us in Discord", "Star us on GitHub"]}
  ]
}
```
