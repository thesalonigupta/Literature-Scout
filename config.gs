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
 *   1.  Relevance topics (used by relevanceFilter.gs)
 *   1B. Topic tiers (used by relevanceScore.gs for ranking)
 *   1C. Gated topics (terms that need corroborating vocabulary)
 *   1D. Field corroboration vocabulary (used by the gate and the ranker)
 *   1E. Low-quality source filters
 *   1F. Boilerplate-context exclusion
 *   1G. Filter toggles
 *   1H. Ranking / scoring settings
 *   2.  Source toggles
 *   3.  Sheet tab names
 *   4.  Source-specific settings
 *   5.  Slack settings
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
// entirely. Now that papers are also RANKED (see section 1H), the cost of a
// borderline catch is even lower — it lands in the Context tier at the bottom
// of the sheet rather than competing for attention with the good stuff.
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
// 1B. TOPIC TIERS
// ---------------------------------------------------------------------------
//
// Every TOPICS term belongs to exactly one of three tiers. The tier decides
// how many points a match is worth when relevanceScore.gs ranks a paper.
// This is the main dial for tuning what floats to the top of the Digest.
//
//   CORE       — the term IS your field's central subject matter. A single
//                match is a strong signal on its own.
//   SUPPORTING — genuinely relevant, but the term also appears routinely in
//                adjacent literature where it isn't the main focus.
//   CONTEXT    — useful background at most. Terminology that could lead to
//                adjacent papers, but rarely to must-read ones.
//
// Anything in TOPICS but missing from all three lists below is treated as
// SUPPORTING (a safe middle default), and logged once per run so the
// omission gets noticed. Run validateTopicTiers() from the Apps Script
// editor after editing.
//
// The tier lists below match the illustrative epidemiology placeholder TOPICS
// above. Replace them entirely when you replace TOPICS.

const TOPIC_TIER_CORE = [
  'transmission dynamics',
  'infection fatality rate',
  'seroprevalence',
  'incubation period',
  'antimicrobial resistance',
  'basic reproduction number',
  'zoonotic spillover',
];

const TOPIC_TIER_SUPPORTING = [
  'herd immunity threshold',
  'contact tracing',
];

const TOPIC_TIER_CONTEXT = [
  'emergence',
  'spillover',
];

// ---------------------------------------------------------------------------
// 1C. GATED TOPICS
// ---------------------------------------------------------------------------
//
// Some TOPICS terms are standard vocabulary in fields unrelated to yours.
// A "gated" topic only counts toward relevance if the paper ALSO either:
//   (a) contains at least one GATE_CORROBORATION_TERM in its title/abstract,
//       or
//   (b) matches some other, non-gated TOPICS term.
//
// Use this when AMBIGUOUS_TOPICS isn't strong enough — ambiguous terms only
// require any second topic match, but gated terms also accept corroboration
// from specific vocabulary (option a above), which lets you keep papers that
// discuss your topic through related language even when they only match
// one TOPICS entry.
//
// Ships EMPTY by default. Populate from your own run observations.
const GATED_TOPICS = [
  // 'some term',  // YYYY-MM-DD: observed generating false positives in
  //               // [field] unrelated to yours; needs corroboration
];

const GATE_CORROBORATION_TERMS = [
  // Words that, if found in a paper's title or abstract, satisfy the gate
  // for any term in GATED_TOPICS. Use vocabulary strongly associated with
  // your field's subject matter — not general academic words.
  //
  // Example (for an epidemiology tool):
  // 'epidemic', 'pandemic', 'outbreak', 'pathogen', 'surveillance'
];

// ---------------------------------------------------------------------------
// 1D. FIELD CORROBORATION VOCABULARY
// ---------------------------------------------------------------------------
//
// Words that indicate a paper is genuinely about your research area, as
// opposed to using field vocabulary incidentally. Used by relevanceScore.gs
// as a corroboration bonus: a paper matching a topic once in a passing
// sentence scores lower than one that also uses several of these words.
//
// Matched as whole words, case-insensitive. Keep this list specific —
// adding common words (e.g. "study", "analysis", "data") makes the bonus
// meaningless because nearly everything scores it.
//
// The list below matches the illustrative epidemiology placeholder. Replace
// with vocabulary central to your own field's subject matter.
const MIND_VOCAB = [
  'epidemic',
  'pandemic',
  'outbreak',
  'pathogen',
  'disease',
  'infection',
  'transmission',
  'mortality',
  'morbidity',
  'surveillance',
  'incidence',
  'prevalence',
  'vaccine',
  'immunity',
  'host',
];

// ---------------------------------------------------------------------------
// 1E. LOW-QUALITY SOURCE FILTERS
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
// CAVEAT: some fields legitimately use Zenodo for citable software releases,
// datasets, or conference proceedings archives. If that's common in your
// field, this default will cost you real results — remove it or narrow it
// (e.g. only flag records that ALSO match a LOW_QUALITY_TEXT_PATTERNS entry).
const BLOCKED_DOI_PREFIXES = [
  '10.5281/zenodo',
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
  /axiomatic .{0,20}(theory|foundation)/i,  // grand-unifying-theory framing
  /self[- ]?published|private press/i,      // stated non-venue
  /originally submitted to/i,               // repackaged rejected submission
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
// 1F. BOILERPLATE-CONTEXT EXCLUSION
// ---------------------------------------------------------------------------
//
// Catches papers that only match TOPICS because of boilerplate sentences
// (ethics declarations, compliance statements, standard methodology
// disclaimers) rather than because the paper is actually about your field.
// A match is rejected only when ALL of: (a) the ONLY TOPICS matched are in
// BOILERPLATE_CONTEXT_TOPICS, AND (b) the text contains one of
// BOILERPLATE_CONTEXT_PATTERNS, AND (c) no field-core language is present.
//
// Ships EMPTY by default. Populate if you observe this pattern.
const BOILERPLATE_CONTEXT_TOPICS = [
  // Topics that routinely appear as boilerplate in papers from adjacent
  // fields (e.g. ethics declarations, method disclaimers).
];

const BOILERPLATE_CONTEXT_PATTERNS = [
  // Regex patterns that identify boilerplate sentences.
];

// ---------------------------------------------------------------------------
// 1G. FILTER TOGGLES
// ---------------------------------------------------------------------------
//
// Each of these switches one rejection rule on or off. Everything rejected is
// gone from the Sheet with no record, so these are the highest-consequence
// settings in this file. Flip one, run the Scout, and check the Run Log's
// "Relevant After Filter" count before and after.
const FILTER_TOGGLES = {

  // Reject papers whose ONLY matched topics are in THEORY_ONLY_TOPICS.
  // The main defence against self-published "grand unified theory" content
  // that packs in several mechanism buzzwords with no applied content.
  // Set to false if you'd rather see those papers and let the Context tier
  // sort them to the bottom.
  rejectTheoryOnlyPapers: true,

  // Reject papers whose only matched topics are context-tier terms.
  // Off by default — context-tier papers are de-prioritised by ranking
  // rather than deleted, which keeps them available without cluttering
  // the top of the Digest. Enable if you find context-tier papers are
  // generating too much noise even at the bottom of the sheet.
  rejectPolicyOnlyPapers: false,

  // Require gated topics (section 1C) to be corroborated. Leave on.
  enforceGatedTopics: true,
};

// ---------------------------------------------------------------------------
// 1H. RANKING / SCORING SETTINGS
// ---------------------------------------------------------------------------
//
// Used by relevanceScore.gs. Every paper that survives the filter gets a
// numeric score and a tier, both written to the Digest sheet so the sheet can
// be sorted by relevance instead of only by date.
//
// How the score is built, in plain terms:
//   - Each distinct matched topic contributes points based on its tier.
//   - A topic that appears in the TITLE counts double (titles are a much
//     stronger signal of subject matter than abstracts).
//   - Matching several core/supporting topics adds a small breadth bonus.
//   - Field corroboration vocabulary words (section 1D) add a bonus.
//   - Preprint/self-deposit DOIs and missing abstracts subtract a little.
//
// To make the Digest more selective, raise coreThreshold. To see more in the
// top tier, lower it. Nothing is ever deleted by these numbers.
const RELEVANCE_SCORING = {

  // Points per distinct matched topic, by tier (section 1B).
  topicPoints: {
    core: 15,
    supporting: 6,
    context: 2,
  },

  // A topic found in the title is worth this many times its normal points.
  titleMultiplier: 2,

  // Small bonus for matching several DIFFERENT core/supporting topics.
  // Deliberately excludes context-tier topics: rewarding breadth there would
  // reward exactly the "list every theory/mechanism" pattern that marks
  // self-published work.
  breadthBonusPerExtraTopic: 2,
  breadthBonusCap: 6,

  // Bonus per DISTINCT field-corroboration vocabulary word found (section 1D).
  mindVocabBonusPerTerm: 2,
  mindVocabBonusCap: 8,

  // Penalties.
  noAbstractPenalty: 3,   // can't judge a paper we can't read
  preprintPenalty: 4,     // self-deposit repositories, see PREPRINT_DOI_PREFIXES

  // Tier cut-offs. A paper scores into the highest tier it clears.
  coreThreshold: 18,
  adjacentThreshold: 10,

  // Guard rails, applied AFTER the thresholds:
  //   - A paper that matched no core or supporting topic can never reach the
  //     Core tier, however many context-tier terms it stacked up.
  //   - A paper with a real abstract needs at least this many distinct
  //     field-corroboration vocabulary words to reach Core. This stops a
  //     title pun or a one-line mention from topping the sheet.
  minMindVocabForCore: 2,
};

// DOI prefixes for repositories that publish without peer review. Unlike
// BLOCKED_DOI_PREFIXES these are NOT rejected — they just lose a few points,
// because relevant preprints legitimately appear on all of them.
const PREPRINT_DOI_PREFIXES = [
  '10.6084',    // figshare
  '10.17605',   // OSF
  '10.31235',   // SocArXiv (OSF preprints)
  '10.13140',   // ResearchGate
  '10.17613',   // Humanities Commons
  '10.33774',   // Cambridge Open Engage
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
  removed: 'Removed',   // papers you rejected — kept so they don't come back
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

  // Lowest tier that gets its own individual Slack message. Papers below
  // this still go in the Sheet and still appear in the summary count —
  // they just don't each ping the channel.
  // One of: 'core', 'adjacent', 'context'.
  // Defaults to 'context' so everything posts until you've tuned your tiers.
  minTierForIndividualPosts: 'context',
};
