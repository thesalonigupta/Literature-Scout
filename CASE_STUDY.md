# Case Study: Tuning a Real Deployment

> **Note on versions.** This case study was written against an earlier
> version of the relevance filter, which used a single flat `TOPICS` list
> plus an `AMBIGUOUS_TOPICS` exception list (a term there needed a second
> matched term to count). The current filter replaces that with context
> tiers: a term that is only relevant in a particular setting goes in a
> `CONTEXT_TOPICS` group with anchors that define that setting, and a term
> that tends to appear in passing goes in `WEAK_TOPICS` (see config.gs
> section 1). Wherever this document says "moved to `AMBIGUOUS_TOPICS`",
> read "moved into a context group, or marked weak". The lessons about
> *when* to make a change carry over unchanged.

`README.md`'s "Adapting This to Your Field" section explains the rules —
compound phrases over bare words, `AMBIGUOUS_TOPICS` for terms that mean
something specific in your field but something else elsewhere, don't act
until you've observed a real false positive. This document is the worked
example: an actual sequence of tuning decisions from a real deployment,
in the order they happened, so you can see what "observing a real false
positive" looks like in practice rather than just the abstract rule.

The field in this case study was an applied environmental-and-animal-
protection research center, organized around three pillars: industrial
animal agriculture, conservation, and governance. None of the specifics
matter for the lesson — swap in your own field's vocabulary and the same
sequence of problems will show up in different clothes.

---

## Round 1: the topic list was too narrow

The first real run returned about 28 papers across four sources over an
8-day window — noticeably low. Two separate causes turned out to be
tangled together:

**Crossref structurally underperforms for this pipeline.** Crossref
rarely includes abstracts (see the note in `fetchCrossref.gs`), and this
pipeline's relevance filter requires the topic phrase to appear in
title+abstract. Crossref's own search is fuzzy and relevance-ranked, but
a Crossref candidate with no abstract can only pass the downstream filter
if the phrase happens to land in the (often short) title. This isn't
fixable by adding more topics — it's a mismatch between how Crossref
searches and how this pipeline filters.

**The topic list itself was genuinely narrow.** The initial list covered
maybe 45 terms. Expanding it — per-species welfare terms, alternative-
protein terminology variants, named policy frameworks, wildlife-trade and
restoration vocabulary, governance terms like "rights of nature" and
"multispecies justice" — took the list to roughly 75 terms and more than
doubled the per-run volume (28 → 62+) with the added terms performing
well on the whole.

**Lesson:** if volume looks low, check both things separately. A source
mismatch and a thin topic list produce the same symptom but need
different fixes.

---

## Round 2: a term shared with an entire other field

The topic `greenwashing` was added for corporate sustainability-claim
accountability in the food/agriculture sense. In practice it flooded the
results with unrelated corporate-finance and ESG research — papers about
blockchain supply chains, ETF pricing, employee stock ownership,
mutual funds — none connected to the target field at all. Out of roughly
25 matches on this term in one run, only one or two were genuinely
on-topic.

This is a more severe version of the `AMBIGUOUS_TOPICS` pattern than
README's philosophy-of-mind example: it wasn't a *little* noise mixed
with real signal, it was almost entirely noise, high enough volume that a
pairing requirement wasn't a strong enough fix (a generic ESG paper could
easily co-occur with some other loosely-related topic by chance). The fix
instead was deleting the bare term and replacing it with the specific
compound phrases the field actually meant: `meat and dairy greenwashing`,
`agricultural greenwashing`, `animal agriculture greenwashing`. This cost
one borderline true positive (a paper that used "greenwashing" and "beef
supply chain" as separate phrases, never the exact compound) in exchange
for eliminating dozens of false ones — the same trade-off `README.md`
describes for the OR-matching philosophy generally, just at the topic
level instead of the paper level.

**Lesson:** `AMBIGUOUS_TOPICS`'s pairing requirement assumes the noise is
a *minority* of matches. If a term is so generic that it's flooding
almost entirely with unrelated content, narrowing the term itself to the
specific phrase your field actually uses is a better fix than pairing.

---

## Round 3–5: the same shared-vocabulary pattern, one term at a time

Over the following several runs, four more terms showed the classic
`AMBIGUOUS_TOPICS` pattern — genuinely useful in the target field, but
also ordinary vocabulary in one or more unrelated fields:

- **`one health`** matched straight zoonotic-disease/AMR microbiology
  papers (feline disease diagnostics, hantavirus reviews, fish-market
  pathogen resistance) using the term as generic public-health framing,
  with no connection to the target field's actual concerns.
- **`sustainable development goals`** matched a COVID/road-noise housing
  economics paper, a Turkish occupational fire-safety statistics paper,
  and a generic "vision for microbiology in [region]" piece — the phrase
  is boilerplate framing across nearly all of academia, not a field-
  specific signal.
- **`planetary boundaries`** matched a pure AI/ML paper (the phrase
  appeared only as a passing resource-consumption aside) and a literary-
  criticism piece on a novel via an unrelated political theory — cited as
  a general concept across fields with nothing to do with the target
  field's use of it.
- **`plant-based protein`** matched a crop-disease pathology paper, a
  food-chemistry flavor-binding study, and an organic-farming agronomy
  paper — basic crop science and food chemistry that happened to mention
  a protein-rich plant, not the field's actual alternative-protein/food-
  systems interest.
- **`legal standing`** matched a paper about immigration enforcement in
  medical clinics — a generic legal-rights sense of the phrase, unrelated
  to the field's animal/environmental legal-personhood usage.

Each was moved to `AMBIGUOUS_TOPICS` individually, as the false positive
was actually observed — not preemptively, and not all at once as a batch
guess. Each entry got a one-line note recording what the false positive
was and when it was seen, exactly as `relevanceFilter.gs` asks for.

**Lesson:** this pattern recurs. It is not a one-time cleanup you do
after the first run and then stop watching for — a term that looked
clean for the first several runs can still turn out to be a different
field's vocabulary too, the moment a new source (see below) starts
surfacing content from that other field.

---

## Round 6: a repeat offender across runs, not a one-off

`green infrastructure` matched a book review on national economic
digital-transformation policy and a soil-bioremediation paper — twice,
across two separate runs, both clearly unrelated to the field's actual
wildlife/urban-green-infrastructure usage. Because it recurred rather
than appearing once, it was moved to `AMBIGUOUS_TOPICS` with confidence
that it wasn't a fluke. The field's own list already had more specific
compound terms (like a term for a specific wildlife-safety infrastructure
feature) to catch the clearly-relevant cases on their own, so the cost of
requiring a pairing was low.

**Lesson:** one observed false positive is enough to act on if it's
unambiguous (see Round 2's terms, most single-instance). A borderline or
uncertain case is worth waiting for a second occurrence before acting —
the difference between "worth watching" and "worth fixing now" in
practice was usually whether the false positive was a clear miss or an
arguable one.

---

## Round 7: low-quality, non-scholarly content — a new source, a new pattern

Adding a new source (in this case, an open-access aggregator search)
surfaced a different problem than topic drift: raw datasets with no real
abstract (data-dump entries with titles like "MINITAB FILES ON X" rather
than papers), all carrying a DOI prefix from a specific no-review self-
deposit repository. This is the same failure mode `config.gs`'s default
Zenodo blocklist entry addresses, just from a different repository — so
the fix was the same shape: add the new prefix to `BLOCKED_DOI_PREFIXES`,
with a comment recording what was observed.

Separately, a handful of self-published PhilPapers "Declarations" and
"Petitions" from the same author — grandiose, non-scholarly policy
manifestos, not peer-reviewed research — showed the pattern
`config.gs`'s `AUTHOR_BLOCKLIST` exists for. One thing worth noting: in
this case, moving the *topic* the papers had matched (`sustainable
development goals`) into `AMBIGUOUS_TOPICS` for unrelated reasons already
filtered these out too, since they hadn't matched anything else. The
author-blocklist entry was added anyway, as a hedge against the same
author's future output landing on a different, not-yet-ambiguous topic —
the same "redundant today, kept as hedge" reasoning `config.gs`'s comment
block describes.

**Lesson:** every new source is worth watching for its own version of
this pattern, not just topic drift. A source's incentive structure (zero-
review self-deposit, aggregation of grey literature, etc.) predicts what
kind of low-quality content it will surface, even before you've seen a
concrete example.

---

## Summary: the actual workflow, in order

1. Run the pipeline for real.
2. Read every row in the Digest sheet, not just the total count.
3. For each topic that produced an off-topic match: is this term a
   *little* noisy (pairing fixes it — `AMBIGUOUS_TOPICS`) or *mostly*
   noise (narrowing the term itself fixes it better)?
4. For each non-scholarly result: does it share a DOI prefix with other
   junk (`BLOCKED_DOI_PREFIXES`), a repeat author (`AUTHOR_BLOCKLIST`),
   or a text pattern (`LOW_QUALITY_TEXT_PATTERNS`)?
5. Annotate every change with what you saw and when — the annotation is
   what lets the *next* change be evaluated on its own merits instead of
   re-litigating settled ones.
6. Re-run. Repeat.

There is no version of this list that's ever really "done" — new topics
get added as your field's vocabulary grows, new sources surface new
failure modes, and terms that were clean can start drifting the moment
your topic list or source mix changes. The point isn't to reach a
finished state; it's to build the habit of tuning from observed evidence
instead of guessing.
