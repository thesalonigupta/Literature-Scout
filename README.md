# Literature Scout

A Google Apps Script tool that monitors four academic sources — arXiv, Crossref, PhilPapers, and OpenAlex — for new papers matching your research topics, logs relevant results to a Google Sheet, and optionally posts them to a Slack channel. It runs entirely inside Google's infrastructure with no installations, servers, or paid subscriptions required beyond two free API credentials.

Two more sources (PubMed, bioRxiv) are available as opt-in plug-ins in `sources/optional/` for fields that overlap biology, medicine, or life sciences — see `SOURCES.md` for what's included, what was evaluated and rejected, and how to wire in something else your field needs that isn't listed here.

---

## Quick Start

1. Create a new Google Sheet, open **Extensions → Apps Script**, and paste each `.gs` file into its own script file.
2. Add `appsscript.json` via Project Settings → Show manifest file.
3. Store your two credentials in Script Properties (see Steps 6–7 in Setup below): `OPENALEX_API_KEY` and, later, `SLACK_WEBHOOK_URL`.
4. Edit `config.gs`: replace the placeholder topic list with your own research vocabulary and set your Crossref contact email. Then run `setupDigestSheet`, followed by `testFetchAllSourcesWithoutWriting`.

Everything else is covered in the full setup below.

---

## Full Setup

### Part 1 — One-Time Setup

**Step 1: Get the files**
You should have a folder containing 12 files ending in `.gs`, plus one file named `appsscript.json`. The `.gs` files are: `config`, `normalize`, `dedupe`, `relevanceFilter`, `relevanceScore`, `writeToSheet`, `fetchArxiv`, `fetchCrossref`, `fetchPhilPapers`, `fetchOpenAlex`, `postToSlack`, `main`. (`sources/optional/` holds additional opt-in source files — leave those out of this step unless you already know you want one; each has its own wiring instructions in its header. See `SOURCES.md`.)

**Step 2: Create a new Google Sheet**
Go to sheets.google.com and create a new blank spreadsheet. Name it something recognizable, such as "Literature Scout."

**Step 3: Open the Apps Script editor**
In the Sheet, go to **Extensions → Apps Script**. This opens a code editor tied to the Sheet.

**Step 4: Add all 12 code files**
Apps Script starts with one empty file called `Code.gs`. Rename it to `config` (double-click the filename), delete its placeholder text, paste in the contents of `config.gs`, and save (Cmd/Ctrl+S). Repeat for each remaining `.gs` file: click the `+` next to "Files" in the sidebar, choose Script, name it to match the filename without the `.gs` extension, and paste in its contents. Order does not matter.

**Step 5: Add the manifest file**
Click the gear icon (Project Settings). Check "Show appsscript.json manifest file in editor." Go back to the editor, open `appsscript.json`, select all, delete, paste in the contents of the real `appsscript.json` file, and save.

**Step 6: Get a free OpenAlex API key**
OpenAlex requires a free API key. Go to openalex.org/signup, create a free account, then go to openalex.org/settings/api and copy your key.

**Step 7: Store the OpenAlex key securely**
Never paste the key directly into a code file. In the Apps Script editor, click the gear icon → Script Properties → Add script property. Set the property name to `OPENALEX_API_KEY` and paste your key as the value. Save.

**Step 8: Edit config.gs**
Open `config.gs` and make three changes before running anything:

- Replace the placeholder `TOPICS` list with your own research vocabulary. See "Adapting This to Your Field" below for guidance on building that list.
- Under `SOURCE_SETTINGS.crossref`, replace the `politeEmail` placeholder with a real contact address. This is not a login credential — Crossref uses it to contact you if something is wrong with your usage pattern.
- Under `SOURCE_SETTINGS.arxiv`, replace the placeholder `categories` with the arXiv category codes most relevant to your field. The full taxonomy is at arxiv.org/category_taxonomy. This is the one setting that has no universal default — you must change it.

**Step 9: Create the Digest sheet**
In the function dropdown at the top of the editor, select `setupDigestSheet` and click Run (▷). The first time you run anything, Google will ask you to authorize the script — choose your account, click "Advanced," then "Go to [project name] (unsafe)," then "Allow." This is normal for any script you create yourself. After it runs, check your Sheet: a new tab called Digest should exist with column headers.

**Step 10: Set up Slack notifications (optional)**
Slack posting is off by default. Do this step when you are ready to have new papers appear in a channel, not necessarily on day one.

1. Go to api.slack.com/apps → Create New App → From Scratch. Name the app and pick your workspace.
2. Open Incoming Webhooks and switch it on.
3. Click Add New Webhook to Workspace, choose a channel, and click Allow.
4. Copy the Webhook URL Slack provides (it looks like `https://hooks.slack.com/services/T00/B00/XXXXXXXX`).
5. In the Apps Script editor, go to Project Settings → Script Properties → Add script property. Set the name to `SLACK_WEBHOOK_URL` and paste the webhook URL as the value. This is a credential; treat it the same way as the OpenAlex key.
6. In `config.gs`, find the `SLACK` block near the bottom and change `enabled: false` to `enabled: true`.
7. Select `postTestMessageToSlack` from the function dropdown and click Run. A test message should appear in the channel within a few seconds. If nothing arrives, check View → Logs for an error message.

You can leave `SLACK.enabled` as `false` indefinitely if you prefer to check the Sheet manually.

---

### Part 2 — Running the Tool

**Test run (recommended first, and after any code change)**
Select `testFetchAllSourcesWithoutWriting` from the function dropdown and click Run. This checks that all four sources are working without writing anything to the Sheet or posting to Slack. Check results under View → Logs or in the Executions panel. You should see one line per source with a candidate count. If any source shows an error, that source has a problem — the others still work independently.

**Real run**
Select `runLiteratureScout` from the function dropdown and click Run. This takes a few minutes: it fetches candidates, checks for duplicates, filters for relevance, writes results, and posts to Slack if enabled. When it finishes, check the Digest tab for new rows, the Run Log tab for a summary, and the Slack channel if configured.

Running it again will not create duplicates and will not re-post anything already posted — the deduplication step checks all three identifier types (DOI, arXiv ID, title hash) against every previously logged paper.

**Reading the Run Log**

| Column | Meaning |
|---|---|
| Candidates Found | Total papers returned by all sources before any filtering |
| New After Dedupe | How many were not already logged from a previous run |
| Relevant After Filter | How many matched at least one topic — what got added to the Digest and posted to Slack |
| Errors | Any source or Slack post that failed (others still complete normally) |

**Setting up a recurring schedule**
In the Apps Script editor, go to Triggers (clock icon) → Add Trigger. Choose `runLiteratureScout`, set a weekly or daily schedule, and save.

**If something goes wrong**

- A source shows an error: re-run `testFetchAllSourcesWithoutWriting` — the error message usually explains what happened (missing API key, service temporarily down, etc.).
- Nothing new after a real run: check the Run Log. If "New After Dedupe" is 0, everything found this time was already logged from a previous run — expected behavior if you run it again soon.
- Slack messages are not arriving but the Sheet updated: check the Run Log's Errors column, or run `postTestMessageToSlack` to isolate whether it is a webhook configuration problem or something about that specific run.
- A paper seems wrongly included or excluded: the relevance logic is in `relevanceFilter.gs` and the topic list is in `config.gs`.

---

## Adapting This to Your Field

The first question is where the topic list comes from. The example topics in `config.gs` are placeholders — I did not write them by brainstorming. I started from vocabulary documents the research team had already produced: a glossary, theoretical-position notes, a review paper's keyword section, something representing terms the field had already decided were worth tracking. That starting point matters because it gives you terms your community actually uses, in the exact phrasing it uses them, rather than terms you guess the community uses.

Once you have that source material, the main editorial task is deciding what to cut. The temptation is to keep single generic words because they feel relevant — "welfare," "agency," "rights," "consciousness" — but a bare word like that will match enormous volumes of literature that has nothing to do with your research area. In a philosophy of mind configuration, several of those words appeared explicitly in the glossary and were still excluded. What survived the cut were compound phrases and terms of art that carry the field's specific meaning: "moral patienthood" rather than "patient," "phenomenal consciousness" rather than "consciousness," "integrated information theory" rather than "theory." The test is roughly: could a paper from an entirely different discipline use this word without any connection to your interests? If yes, remove it or find the compound form that is specific to your field.

The filter uses OR rather than AND: a paper qualifies if its title or abstract contains any one of your terms, not multiple terms together. This is the correct trade-off for a scout tool. Requiring two terms to co-occur would mean missing a paper on a topic your field tracks simply because the author used slightly different vocabulary in the abstract — a real loss, with no way to recover it later. Including a paper that matched only one term and turns out on inspection to be off-topic costs a few seconds of review. The finer scoring against your actual research questions belongs in whatever triage or relevance-ranking step happens downstream; this filter only needs to be good enough to exclude clear non-matches.

Matching is done by literal substring, not by stemming or fuzzy search. "Moral status" will not match "the moral and legal status of" because there is an extra word between "moral" and "status" in that phrase. The practical consequence is that if your field uses a term in multiple phrasings, each phrasing needs its own entry. "Higher order thought" and "higher-order thought" — with and without the hyphen — are separate entries in a philosophy of mind configuration for exactly this reason. Add variants when you encounter them in real results, not as a preemptive exercise.

The only way to know whether a topic list is working is to run it and read the results. After a few runs you will start to notice a pattern: a term that keeps showing up on papers that have nothing to do with your research area. Usually this happens because the term means something specific in your field but is also an ordinary word or phrase elsewhere. "Functionalism" is a philosophy-of-mind term of art; it is also used in Durkheimian sociology (to describe a theory of social institutions), in design theory, and in descriptions of nonprofit organizational models. "Individuation" in philosophy of mind means something precise about the counting of subjects; in a general corpus it matches papers on tactile perception, on Rousseau's theory of property, and on various strands of unrelated metaphysics. When you encounter this pattern, the right response is not to delete the term — you would lose the legitimate matches too. Move it to `AMBIGUOUS_TOPICS` in `relevanceFilter.gs` instead.

A term in `AMBIGUOUS_TOPICS` still participates in matching, but a match on that term alone is no longer sufficient to include a paper. The paper must also match at least one other term from the main list. This is a narrow exception to the OR rule, not a general shift to AND-logic. A paper that matches "functionalism" and also matches "phenomenal consciousness" is almost certainly relevant; a paper that matches only "functionalism" needs a second signal before it clears the relevance bar. Keep `AMBIGUOUS_TOPICS` small. Its purpose is to handle a specific, observed failure mode — a term that is genuinely useful in combination but consistently misleading when it appears alone.

Two rules govern what goes into `AMBIGUOUS_TOPICS`. First, add a term only after you have seen it produce a real off-topic result in a real run, not as a precaution against a result you are imagining. Speculative additions add complexity without fixing anything. Second, annotate every entry with a one-line description of the false positive you observed and when you saw it — what the paper was about, what other field or usage the term surfaced from. That annotation is not decoration; it is the evidence record that lets a future maintainer decide whether the term's behavior has changed and whether it can safely be removed or restored to the main list.

---

## Credential and Ownership Notes

**Credential and Ownership Notes** — the short version is below; see
`OWNERSHIP.md` for the full transfer checklist.

**Script Properties** — the correct place for both credentials (`OPENALEX_API_KEY`, `SLACK_WEBHOOK_URL`). They belong in Script Properties at runtime; they should also be stored in your team's shared password manager so they are recoverable if the project ever needs to be rebuilt from scratch.

**Apps Script trigger ownership** — time-based triggers run as the account that created them. If that account loses access, the trigger stops silently. When transferring ownership of the Sheet, recreate the trigger under the new owner — it does not carry over automatically.

**Sharing** — share the Sheet with at least one other person as Editor. Editors can open Apps Script, view and run every function, and read Script Properties, which means someone else can operate the tool even before a formal handoff.

---

## Further Reading

- **`SOURCES.md`** — which sources are wired in by default, which are
  optional plug-ins (`sources/optional/`), which were evaluated and
  rejected and why, and a checklist for evaluating any new source you're
  considering adding.
- **`CASE_STUDY.md`** — a real, worked sequence of topic-list tuning
  decisions across several runs: a term that flooded with an unrelated
  field's content, terms that drifted into `AMBIGUOUS_TOPICS` one at a
  time as false positives were actually observed, and a low-quality-
  source pattern that showed up with a new source. Useful as a concrete
  companion to the more abstract rules in "Adapting This to Your Field"
  above.
- **`OWNERSHIP.md`** — the full account-transfer checklist referenced
  above.

---

## License

MIT — see LICENSE file.
