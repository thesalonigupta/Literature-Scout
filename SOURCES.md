# Sources — What's In, What's Out, and Why

This tool ships with four default sources (arXiv, Crossref, PhilPapers,
OpenAlex) and two optional ones (PubMed, bioRxiv — see `sources/optional/`).
Along the way, three other sources were evaluated and rejected. This file
exists so a future maintainer doesn't spend an afternoon rediscovering the
same dead ends — and so you have a template for evaluating whatever source
your own field actually needs that isn't listed here.

---

## Default sources

| Source | Needs a key? | Keyword search? | Notes |
|---|---|---|---|
| arXiv | No | Yes | Strong for CS/physics/math/quant-bio; weak-to-nothing for humanities, law, social science, agriculture. Check `arxiv.org/category_taxonomy` before assuming it's worth the API calls for your field. |
| Crossref | No (polite email) | Yes | Broadest catch-all for traditionally-published journal articles. Rarely includes abstracts — see the note in `fetchCrossref.gs`. Its own search is fuzzy/relevance-ranked, but this pipeline's downstream filter requires an exact phrase match in title+abstract, so a Crossref candidate with no abstract can only pass if the phrase happens to be in the title. |
| PhilPapers | No | **No** — OAI-PMH browse only | Only surfaces self-archived/open-access content, not the full paywalled index. See `fetchPhilPapers.gs`'s header for the full limitation and the two-pass "pull everything, pre-filter client-side" workaround this forces. |
| OpenAlex | Yes (free) | Yes | Secondary/redundant check — draws heavily from Crossref, so most of what it finds is already caught elsewhere. Included to catch cases where OpenAlex indexed an abstract Crossref didn't surface. |

## Optional sources (`sources/optional/`)

| Source | Needs a key? | Keyword search? | Add it if... |
|---|---|---|---|
| PubMed/PMC | No (email + optional NCBI key) | Yes | Your field touches biology, medicine, veterinary/animal science, public health, nutrition, epidemiology, or psychology. Reliably includes real abstract text, unlike Crossref — often the single biggest quality improvement available. |
| bioRxiv | No | **No** — category + date browse only | Your field overlaps general biology (genetics, ecology, neuroscience, animal behavior, microbiology, evolutionary biology). Same two-pass client-side pre-filter pattern as PhilPapers, since there's no keyword search. |

Neither is wired into `main.gs` or `config.gs` by default — each file's
header has the exact wiring steps (`SOURCES_ENABLED`, `SOURCE_SETTINGS`,
the `main.gs` calls). Don't add a source just because it exists; add it
because your field's literature actually lives there.

## Considered and rejected

**CORE (core.ac.uk)** — Aggregates open-access repositories worldwide
(theses, institutional repositories, grey literature). Technically works —
real keyword search via `/v3/search/works`, genuine abstracts in most
records — but requires a free API key that needs periodic renewal, which
turned out not to be worth the upkeep for a source playing a
secondary/redundant role (same category as OpenAlex). Revisit if your
field's most important content specifically lives in institutional
repositories CORE indexes and Crossref/OpenAlex don't reach — the
trade-off may look different for you. One thing to verify before
reintroducing it: this build used `publishedDate>="cutoff"` for the
lookback-window filter based on a documented pattern for a *different*
field (`yearPublished`), not a confirmed-working pattern for
`publishedDate` specifically — check that carefully in a test run before
trusting it.

**RePEc/IDEAS** — Not viable at all for this pipeline's shape. Their API
is explicitly not self-service (access requires manually requesting a
code from RePEc), and even with access, the available functions
(`getref`, `getrecentpapers`, `getauthorshortid`, etc.) look up a
*specific known* paper/author/series by handle — there's no "give me
everything matching this keyword from the last N days" function at all.
If your field is economics-heavy and RePEc coverage matters a lot, the
more realistic path is a documented working paper series you already know
by handle, fetched via `getrecentpapers` — a fundamentally different
integration shape than every other file in this repo, not a drop-in
fetchX.gs.

**EcoEvoRxiv** — Would have been the natural, most-targeted choice for an
ecology/evolutionary-biology field (more specific than bioRxiv's general
"ecology" category). As of when this was evaluated, EcoEvoRxiv was
mid-migration off its OSF-hosted platform onto a new one (CDL's Janeway
system, different domain), with new submissions suspended. Building
against a platform that's actively being decommissioned wasn't worth it.
bioRxiv's "ecology" and "animal_behavior_and_cognition" categories are the
working substitute in the meantime — narrower and less ecology-specific,
but stable. **Check whether EcoEvoRxiv's migration has settled and
whether its new platform has a documented API before assuming this
substitution is still the right call** — this is exactly the kind of
"true when written, may not be true when you read it" fact that ages
fastest in a doc like this one.

---

## Checklist for evaluating a new source

Before writing a new `fetchX.gs`, answer these — in roughly this order,
since each one can save you from building something that doesn't work:

1. **Does it have real keyword/full-text search**, or only browse-by-date
   (like PhilPapers/bioRxiv)? Browse-only isn't disqualifying, but it
   means a two-pass client-side pre-filter (see `fetchPhilPapers.gs` or
   `fetchBioRxiv.gs` for the pattern), not a per-topic query loop.
2. **Does it return real abstract text**, or just titles/metadata (like
   Crossref, most of the time)? A source with no abstracts is much less
   useful to this pipeline's filter, which needs title+abstract text to
   match against.
3. **Is the API actually self-service and documented**, or does it
   require a manually-requested access grant (like RePEc)? If you can't
   get a working key/token within a few minutes of following public docs,
   that's a real signal, not an inconvenience to push through.
4. **Does the auth model create ongoing maintenance burden** — a key that
   expires or needs periodic renewal (like CORE)? Weigh that against how
   much unique, non-redundant content the source actually contributes.
   Redundant-but-annoying isn't worth it; unique-and-annoying might be.
5. **Verify date-filtering syntax in an actual test run**, don't just
   trust documentation examples for a *similar* field/parameter and
   assume they transfer. If a new source returns 0 candidates across
   nearly every topic (not just an occasional zero), the date filter is
   usually the first thing to check.
6. **Is the platform stable**, or mid-migration/actively changing (like
   EcoEvoRxiv at time of writing)? A perfect-fit source on an unstable
   platform is often worse than a broader-fit source on a stable one.

If a source clears all six, it's a good candidate for a `fetchX.gs` file
following the pattern every other source in this repo already uses:
build a list of `NormalizedPaper` objects via `makeNormalizedPaper()` in
`normalize.gs`, and nothing else in the pipeline needs to know it exists.
