# Literature Scout — Setup & Run Guide

Step-by-step instructions to set up the tool from scratch and run it, including Slack notifications.

Literature Scout is a Google Apps Script tool that automatically checks four academic sources (arXiv, Crossref, PhilPapers, OpenAlex) for new papers matching your research topics, logs genuinely new, relevant results to a Google Sheet, and (once set up) posts them to a Slack channel. It runs entirely inside Google's infrastructure — no installations, servers, or paid accounts required, aside from two free credentials (Steps 6 and 10).

---

## Part 1 — One-Time Setup

Do this once. After setup, running the tool is just Step 11 onward, repeated.

**Step 1: Get the files**
You should have a folder containing 12 files ending in `.gs`, plus one file named `appsscript.json`. If you don't have these, get them from wherever you cloned or downloaded the tool.

**Step 2: Create a new Google Sheet**
Go to sheets.google.com and create a new blank spreadsheet. Name it something recognizable, e.g. "Literature Scout."

**Step 3: Open the Apps Script editor**
In the Sheet, go to the menu: **Extensions → Apps Script**. This opens a separate code editor tied to this Sheet.

**Step 4: Add all 12 code files**
Apps Script starts with one empty file called `Code.gs`. You'll turn that into your first real file, then add the other eleven.

- Click on `Code.gs` in the left sidebar, select all the placeholder text, and delete it.
- Rename the file (double-click the filename, or use its ⋮ menu) to `config` — no need to type ".gs", Apps Script adds it automatically.
- Open `config.gs` on your computer, copy everything in it, and paste it into this file in the browser. Save (Cmd/Ctrl+S).
- Repeat for the remaining 11 `.gs` files: click the `+` next to "Files" in the sidebar, choose Script, name it to match the filename exactly (without ".gs"), and paste in its contents.

By the end of this step, your file list should show:
`config`, `normalize`, `dedupe`, `relevanceFilter`, `relevanceScore`, `writeToSheet`, `fetchArxiv`, `fetchCrossref`, `fetchPhilPapers`, `fetchOpenAlex`, `postToSlack`, `main` — twelve script files total. The order you add them in does not matter.

**Step 5: Add the manifest file (appsscript.json)**
This file is created automatically but hidden by default.
- Click the gear icon (Project Settings) in the left sidebar.
- Check the box labeled "Show appsscript.json manifest file in editor."
- Go back to the editor (the `</>` icon). `appsscript.json` now appears in your file list.
- Open it, select all, delete, and paste in the contents of the real `appsscript.json` file. Save.

**Step 6: Get a free OpenAlex API key**
OpenAlex (one of the four sources) requires a free API key as of 2026.
- Go to openalex.org/signup and create a free account (any email works).
- Go to openalex.org/settings/api and copy your key.

**Step 7: Store the OpenAlex key securely**
The key should never be pasted directly into a code file. Store it in Script Properties instead:
- In the Apps Script editor, click the gear icon (Project Settings).
- Scroll to "Script Properties" → click "Add script property."
- Property: `OPENALEX_API_KEY`   Value: (paste your key)
- Save.

**Step 8: Set the contact email for Crossref**
Open `config.gs` in the editor and find `politeEmail` under the crossref settings. Replace the placeholder with a real contact email (this is not a login — just identifies who's making the requests). Save.

**Step 9: Configure your topics**
Open `config.gs` in the editor. The file ships with illustrative placeholder topics. Replace the `TOPICS` list with your own field's vocabulary, and update the `TOPIC_TIER_CORE`, `TOPIC_TIER_SUPPORTING`, and `TOPIC_TIER_CONTEXT` lists to match (one entry per topic). See the README's "Adapting This to Your Field" section for guidance.

**Step 10: Create the Digest sheet**
- In the function dropdown at the top of the editor, select `setupDigestSheet`.
- Click Run (the ▷ button).
- The first time you run anything, Google will ask you to authorize the script — choose your account, click "Advanced," then "Go to [project name] (unsafe)," then "Allow." This warning is normal for any script you create yourself.
- Check your Sheet — a new tab called Digest should now exist with column headers.
- Now select `setupRemovedSheet` from the same dropdown and run it. This creates the Removed tab, where rejected papers go so they do not come back on a later run.

**Step 11: Set up Slack notifications (optional but recommended)**
Slack posting is off by default. Do this whenever you're ready to have new papers show up in a channel, not necessarily on day one.

1. Go to api.slack.com/apps → **Create New App** → **From Scratch**. Name it (e.g. "Literature Scout") and pick your workspace.
2. In the app's settings, open **Incoming Webhooks** and switch it on.
3. Click **Add New Webhook to Workspace**, choose the channel papers should post to, and click Allow.
4. Copy the Webhook URL Slack gives you — it looks like `https://hooks.slack.com/services/T00/B00/XXXXXXXX`.
5. Back in the Apps Script editor: gear icon (Project Settings) → Script Properties → Add script property.
   Property: `SLACK_WEBHOOK_URL`   Value: (paste the webhook URL)
   Save. This is a credential, so — same as the OpenAlex key — it lives in Script Properties, never in a code file.
6. Open `config.gs`, find the `SLACK` block near the bottom, and change `enabled: false` to `enabled: true`.
7. Test it: select `postTestMessageToSlack` from the function dropdown and click Run. A test message should appear in the Slack channel within a few seconds. If nothing shows up, check View → Logs for the error.

You can leave `SLACK.enabled` as `false` indefinitely if you'd rather just check the Sheet manually — nothing else in the tool depends on Slack being set up.

Setup is complete. Everything from here on is just running the tool — see Part 2.

---

## Part 2 — Running the Tool

### Option A: Test run (recommended first, and after any code change)
This checks that all four sources are working without writing anything to the Sheet or posting to Slack.
- Select `testFetchAllSourcesWithoutWriting` from the function dropdown.
- Click Run.
- Check the results: View → Logs, or the Executions panel in the left sidebar. You should see one line per source with a candidate count, e.g.
  ```
  arxiv: 100 candidates
  crossref: 1194 candidates
  philpapers: 13 candidates
  openalex: 1577 candidates
  ```
- If any source shows an error instead of a number, that source has a problem — but the others will still work independently.

### Option B: Real run (adds new papers to the Sheet and posts to Slack)
- Select `runLiteratureScout` from the function dropdown.
- Click Run. This takes longer than the test run — a few minutes — since it also checks for duplicates, filters for relevance, writes results, and posts to Slack (if enabled).
- When it finishes, open your Sheet and check the Digest tab for new rows, the Run Log tab for a summary of what happened, and the Slack channel (if configured) for new messages.
- Running it again won't create duplicates, and won't re-post anything already posted — the Slack step only ever sees papers that just passed dedupe and the relevance filter for the *first* time.

### Reading the Run Log

| Column | Meaning |
|---|---|
| Candidates Found | Total papers returned by all four sources before any filtering |
| New After Dedupe | How many of those weren't already logged from a previous run |
| Relevant After Filter | How many of those actually matched one of your topics — this is what got added to the Digest tab and posted to Slack |
| Errors | Any source (or Slack post) that failed during this run (others still complete normally) |

### Reading the Digest sheet

The Digest sheet has two columns at the right edge — **Relevance Score** and **Relevance Tier** — written by `relevanceScore.gs`. Use them to sort the sheet by relevance rather than only by date. The three tiers:

- **Core** — read this. The paper's subject matches your field's central research questions.
- **Adjacent** — skim this. Genuinely related, but your vocabulary may be doing supporting rather than central work.
- **Context** — file this. Useful background or a citable example at most.

### How often to run it
There is currently no automatic schedule — the tool only runs when someone clicks Run on `runLiteratureScout`. A weekly automatic trigger can be added via **Triggers → Add Trigger** in the Apps Script editor, choosing `runLiteratureScout` and a weekly schedule, once you're comfortable with how it behaves.

### If something goes wrong
- **A source shows an error in the log:** re-run `testFetchAllSourcesWithoutWriting` — the error message (visible in the log) usually explains what happened (e.g. a missing API key, or a service being temporarily down).
- **Nothing new shows up after a real run:** check the Run Log tab — if "New After Dedupe" is 0, it means everything found this time was already logged previously, which is expected if you're running it again soon after a previous run.
- **Slack messages aren't arriving but the Sheet updated fine:** check the Run Log's Errors column for a Slack-related message, or run `postTestMessageToSlack` to isolate whether it's a webhook/config problem versus something about that specific run.
- **A paper seems wrongly included or excluded:** the relevance logic lives in `relevanceFilter.gs` and the topic list lives in `config.gs` — both are plain, commented lists meant to be editable without touching any other file.
- **Papers are ranked unexpectedly:** run `explainScoreForSampleText()` in `relevanceScore.gs` (paste the title and abstract in, select the function, click Run) to see exactly which components contributed to the score.
