/**
 * config.gs
 *
 * SINGLE SOURCE OF TRUTH for tunable settings.
 *
 * If you are maintaining this tool and are NOT an engineer: this is almost
 * certainly the only file you need to touch. Everything below is plain
 * values, not logic — change the lists, not the code around them.
 *
 * Sections:
 *   1. Relevance topics (used by relevanceFilter.gs)
 *   2. Source toggles (turn a fetch source on/off without deleting code)
 *   3. Sheet tab names
 *   4. Source-specific settings (date windows, max results, etc.)
 *   5. Slack settings (used by postToSlack.gs)
 */

// ---------------------------------------------------------------------------
// 1. RELEVANCE TOPICS
// ---------------------------------------------------------------------------
//
// Simple OR-matching: a paper is "relevant" if its title + abstract contains
// AT LEAST ONE of these terms (case-insensitive, whole-word where sensible).
//
// Why OR and not AND: the Scout is meant to cast a wide net. Catching a few
// borderline papers costs a few seconds of skimming; missing a genuinely
// relevant paper because it didn't pair two keywords costs you the paper
// entirely. A downstream triage or relevance-ranking step can do finer-
// grained scoring against your active research questions — this filter only
// needs to be "good enough" to keep obvious noise out.
//
// Start from a vocabulary source your field already maintains (a glossary,
// a review paper's keyword list, a syllabus reading list) rather than
// brainstorming from scratch. See "Adapting This to Your Field" in README.md
// for guidance on building and tuning this list.
//
// Deliberately use compound/specific phrases rather than single generic words.
// Single words that also appear in many unrelated literatures will generate
// high false-positive rates and should be excluded or handled via
// AMBIGUOUS_TOPICS in relevanceFilter.gs.
//
// Keep terms lowercase. Multi-word phrases are matched as exact substrings,
// so "transmission dynamics" will NOT match "the transmission and spread
// dynamics of...". If you want phrase variants, add them as separate entries.
//
// The list below is an illustrative placeholder for an epidemiology /
// infectious-disease research area. Replace it entirely with your own field's
// vocabulary. See "Adapting This to Your Field" in README.md.
const TOPICS = [
  // Transmission and spread
  'transmission dynamics',
  'basic reproduction number',
  'herd immunity threshold',
  'contact tracing',

  // Disease characteristics
  'infection fatality rate',
  'seroprevalence',
  'incubation period',
  'antimicrobial resistance',
  'zoonotic spillover',

  // Terms that were useful in context but turned out to be ambiguous —
  // kept here so they can participate in multi-term matches; see AMBIGUOUS_TOPICS
  'spillover',
  'emergence',
];

// ---------------------------------------------------------------------------
// 1B. LOW-QUALITY SOURCE FILTERS
// ---------------------------------------------------------------------------
//
// Plain topic OR-matching lets through more than off-topic noise — it also
// lets through self-published, non-peer-reviewed content that happens to
// share your field's vocabulary. This has become a cross-disciplinary
// problem as it's gotten trivially easy to generate confident-sounding,
// jargon-heavy "papers" with no institutional review behind them. The
// filters below catch that category specifically, separately from ordinary
// topical relevance. Used by relevanceFilter.gs.

// Zenodo (DOI prefix 10.5281) lets anyone register a DOI with zero review.
// OpenAlex indexes these self-deposits indistinguishably from real journal
// articles. Crossref-sourced records never carry this prefix (Zenodo
// registers through DataCite, not Crossref), so this check is safe to apply
// globally rather than gating it to a specific source.
//
// Mendeley Data (DOI prefix 10.17632) is the same profile — a no-review
// self-deposit repository, mostly for raw datasets rather than papers.
// Observed in practice: a keyword that legitimately matches your field can
// also surface a data-dump entry with no real abstract (e.g. "MINITAB
// FILES ON X" or "X Extracted Data 2023-2025") rather than an actual paper.
//
// CAVEAT (applies to both prefixes): some fields legitimately use Zenodo
// or Mendeley Data for citable software releases, datasets, or conference
// proceedings archives. If that's common in your field, these defaults
// will cost you real results — loosen them (e.g. only flag records that
// ALSO match a pattern below) or remove them entirely.
const BLOCKED_DOI_PREFIXES = [
  '10.5281/zenodo',
  '10.17632', // Mendeley Data
];

// Authors who've repeatedly self-published non-peer-reviewed content that
// matches your TOPICS on vocabulary alone. Matched against lowercase author
// strings. This list ships EMPTY — it's meant to be built up from what you
// actually observe in your own runs, not seeded preemptively, since a wrong
// entry here silently and permanently drops everything by that name with
// no record in the Sheet. Before adding someone, weigh:
//   - Collision risk: is the name distinctive enough that an unrelated
//     legitimate academic sharing it is unlikely? Prefer full "last, first"
//     over a bare surname for this reason.
//   - Redundancy: is this person's observed bad output already caught by
//     BLOCKED_DOI_PREFIXES or LOW_QUALITY_TEXT_PATTERNS below? If so, an
//     author entry is only doing work against their *future*, not-yet-seen
//     output — worth it for a distinctive name, questionable for a common
//     one.
// Note when/why each entry was added, same convention as AMBIGUOUS_TOPICS.
const AUTHOR_BLOCKLIST = [
  // 'surname, firstname', // YYYY-MM-DD: what you observed
];

// Title/abstract patterns strongly associated with self-published, non-
// peer-reviewed content rather than field scholarship. These four are
// discipline-agnostic vanity-press/LLM-slop tells observed in practice —
// keep them as sensible defaults, but treat them the same as everything
// else here: narrow and literal, meant to catch a specific tell, not to
// second-guess unconventional academic ideas.
const LOW_QUALITY_TEXT_PATTERNS = [
  /™/,                               // trademarked jargon in an academic title
  /book [ivxlcdm]+ of [ivxlcdm]+/i,   // serialized self-published book volumes
  /single[- ]premise/i,               // grand-unifying-theory framing
  /here is the abstract/i,           // leaked copy-paste instructions from an LLM-assisted draft
];

// Some TOPICS are pure theory/mechanism terms that, on their own, tend to
// attract content unrelated to your field's actual applied questions —
// analogous to AMBIGUOUS_TOPICS above, but stricter: an AMBIGUOUS_TOPICS
// term counts if paired with ANY other matched topic, while a term in this
// list only counts if paired with a topic OUTSIDE this list. This matters
// because self-published "grand unified theory" content tends to pack in
// SEVERAL pure-theory terms at once (e.g., three or four mechanism buzzwords
// in one abstract, no applied content) — pairing two theory-only terms with
// each other would satisfy AMBIGUOUS_TOPICS's weaker rule but shouldn't
// satisfy relevance on its own.
//
// Ships EMPTY by default — hasAppliedTopicMatch() in relevanceFilter.gs is a
// no-op until you populate this. Fill it in only after observing your own
// version of the pattern: a cluster of your field's theory/mechanism terms
// co-occurring in self-published pieces with none of your field's applied
// terms present.
const THEORY_ONLY_TOPICS = [
  // 'mechanism-only term', // requires pairing with a topic NOT in this list
];

// ---------------------------------------------------------------------------
// 2. SOURCE TOGGLES
// ---------------------------------------------------------------------------
//
// Set to false to skip a source entirely (e.g. if one API is down or you
// want to test the pipeline with fewer calls). main.gs reads these.
const SOURCES_ENABLED = {
  arxiv: true,
  crossref: true,
  philpapers: true,
  openalex: true, // secondary/redundant check — see note in fetchOpenAlex.gs
};

// ---------------------------------------------------------------------------
// 3. SHEET TAB NAMES
// ---------------------------------------------------------------------------
//
// If you rename a tab in the Sheet UI, update it here too — the script
// looks tabs up by name.
const SHEET_TABS = {
  digest: 'Digest',     // main output: one row per relevant new paper
  runLog: 'Run Log',    // one row per script execution, for debugging
};

// ---------------------------------------------------------------------------
// 4. SOURCE-SPECIFIC SETTINGS
// ---------------------------------------------------------------------------
const SOURCE_SETTINGS = {
  arxiv: {
    // CHANGE THIS: arXiv category codes relevant to your field.
    // The placeholder values below are examples only.
    // The full category taxonomy is at arxiv.org/category_taxonomy —
    // search for your area and copy the code from there.
    // If you add many categories, add a Utilities.sleep(3000) call in
    // fetchArxiv.gs between requests to stay within arXiv's rate limit.
    categories: ['cs.AI', 'q-bio.NC'],
    maxResults: 50,
  },
  crossref: {
    // Crossref's `rows` param caps results per query; we query per-topic
    // to keep each query focused, rather than one huge OR query.
    rowsPerQuery: 20,
    // Crossref asks that you identify yourself — fill in a real contact.
    // This is NOT a credential, just an email string sent as a query param
    // so Crossref can reach you if something's wrong with your usage.
    politeEmail: 'YOUR_CONTACT_EMAIL@example.org',
  },
  philpapers: {
    maxResults: 50,
  },
  openalex: {
    maxResults: 25,
    // NOTE: OpenAlex deprecated the mailto "polite pool" system in Feb
    // 2026 — there is no email setting here anymore. Authentication is
    // now via API key, stored in Script Properties as OPENALEX_API_KEY
    // (NOT here — this file is fine to share/view, Script Properties
    // is the credential store). See fetchOpenAlex.gs's file header for
    // setup instructions if this hasn't been configured yet.
  },
};

// ---------------------------------------------------------------------------
// How far back to look for "new" papers on each run.
// 8 days (not 7) gives a 1-day overlap buffer in case a run is ever missed
// or delayed — dedupe.gs will silently skip anything already logged, so
// the overlap costs nothing but protects against gaps.
// ---------------------------------------------------------------------------
const LOOKBACK_DAYS = 8;

/**
 * Returns the cutoff date (as an ISO 'YYYY-MM-DD' string) for "new enough
 * to include this run", based on LOOKBACK_DAYS above. Every fetch*.gs file
 * should use this rather than computing its own cutoff, so changing
 * LOOKBACK_DAYS in one place changes behavior everywhere consistently.
 *
 * @return {string} e.g. '2026-06-18'
 */
function getLookbackCutoffDate() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);
  return Utilities.formatDate(cutoff, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// ---------------------------------------------------------------------------
// 5. SLACK SETTINGS
// ---------------------------------------------------------------------------
//
// The webhook URL itself is a credential and does NOT go here — it lives in
// Script Properties as SLACK_WEBHOOK_URL. See postToSlack.gs's file header
// for the one-time setup steps.
const SLACK = {
  // Defaults to false so a freshly-copied project never posts to a real
  // Slack channel until someone deliberately flips this on (after setting
  // SLACK_WEBHOOK_URL). Flip to true once Slack setup is done.
  enabled: false,

  // If a single run finds more new relevant papers than this, post one
  // summary message linking to the Sheet instead of one message per paper
  // (avoids spamming the channel and Slack's per-webhook rate limit on a
  // first run or after a long gap between runs).
  maxIndividualPosts: 12,
};
