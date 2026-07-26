# Ownership & Continuity

What to do so this tool keeps running when the person who built it moves
on, and what to set up now to make that day easy. `README.md`'s
"Credential and Ownership Notes" section covers the short version; this
is the fuller walkthrough, including the step-by-step transfer checklist.

---

## Why this needs a plan at all

Apps Script projects are tied to whichever Google account created them.
Two consequences that aren't obvious until they bite you:

- **Time-based triggers** (a weekly auto-run) execute *as* the account
  that created them. If that account is deleted or loses access, the
  trigger stops firing — silently. No error email, no red banner. It
  just stops.
- **Script Properties** (`OPENALEX_API_KEY`, `SLACK_WEBHOOK_URL`, and any
  optional-source keys like `NCBI_API_KEY` if you've added PubMed) and
  the code itself belong to the *project*, not to a specific person, so
  they survive fine on their own. The trigger is the one fragile piece.

---

## Do this now, regardless of who owns the account

1. **Share the Sheet with at least one other person as Editor** (two is
   better than one). Editors can open Apps Script, view/run every
   function, and read Script Properties — meaning someone else can
   operate the tool even before any formal handoff happens.
2. **Put every credential in your team's shared password manager**, not
   just in Script Properties:
   - `OPENALEX_API_KEY`
   - `SLACK_WEBHOOK_URL`
   - Any optional-source credentials you've added (e.g. `NCBI_API_KEY`
     if using `sources/optional/fetchPubMed.gs`, or a similar key for any
     other source you've wired in — see `SOURCES.md`)
   Script Properties is the correct place for the *running* script to
   read them from — but if the project ever needs to be rebuilt from
   scratch, you want these recoverable without depending on the original
   account.
3. **If this was built on someone's personal Google account**, migrate it
   to a dedicated non-personal one if you can — something like
   `yourteam.litscout@gmail.com` — so the tool isn't tied to any one
   person's identity at all. Not urgent if Editors are already added, but
   worth doing before it becomes urgent.

---

## Checklist: when the account holder is leaving

Do this *before* their access is revoked, not after.

- [ ] **Transfer Sheet ownership.** In the Sheet: Share → find the
      incoming owner (dedicated account or another team member) → change
      their role to Owner. This also transfers ownership of the attached
      Apps Script project.
- [ ] **Recreate the trigger under the new owner.** This is the step
      people forget. Open the Apps Script project *as the new owner* →
      Triggers (clock icon) → delete the old `runLiteratureScout` trigger
      (it may already show an error icon) → Add Trigger →
      `runLiteratureScout` → same schedule as before. The old trigger
      does not carry over automatically; a new one must be created.
- [ ] **Confirm Script Properties are still intact.** Project Settings →
      Script Properties should still show every credential you're using.
      These normally survive ownership transfer untouched, but check once
      rather than assume.
- [ ] **Run `testFetchAllSourcesWithoutWriting`** as the new owner to
      confirm all sources still work under the new account's
      authorization.
- [ ] **Run `postTestMessageToSlack`** to confirm Slack still works (if
      Slack posting is enabled).
- [ ] Remove the departing person's access last, after the above is
      verified.

Nothing else needs to change — the code, the Digest sheet, the Run Log,
and `config.gs` are untouched by an ownership transfer.

---

## Optional: redundancy without a formal handoff

Because any Editor can add their *own* trigger on the same project, two
people can each run a `runLiteratureScout` trigger weekly, independently,
as a standing safety net. `dedupe.gs` makes this free — a duplicate run
just finds nothing new and logs a quiet, empty-ish row. More setup than
most teams need, but worth knowing it's an option if this tool becomes
load-bearing for your workflow.
