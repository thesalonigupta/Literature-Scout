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
 *   1.  Relevance rules (used by relevanceFilter.gs)
 *   1B. Fetch queries (what Crossref, OpenAlex and arXiv are asked for)
 *   1C. Field vocabulary (ranking bonus, used by relevanceScore.gs)
 *   1D. Low-quality source filters
 *   1E. Ranking / scoring settings
 *   2.  Source toggles
 *   3.  Sheet tab names
 *   4.  Source-specific settings
 *   5.  Slack settings
 */

// ---------------------------------------------------------------------------
// 1. RELEVANCE RULES
// ---------------------------------------------------------------------------
//
// A flat list of terms where any one match anywhere in the title or abstract
// is enough sounds simple, but it lets in papers that use one of your terms
// in an unrelated sense ("spillover" in an economics paper, "emergence" in a
// philosophy paper), and then needs a growing pile of exceptions to patch.
// Instead, terms are sorted by how specific they are. A paper is relevant if
// ANY of these holds:
//
//   (a) It matches a CORE term.
//       Core terms are specific enough to count on their own.
//
//   (b) It matches a CONTEXT term AND mentions one of that term's anchors.
//       Context terms are concepts you care about only when they are applied
//       to your field's subject matter. The anchors (TOPIC_ANCHORS, below)
//       define what "mentions your subject matter" means.
//
// Start from a vocabulary source your field already maintains (a glossary,
// a review paper's keyword list, a syllabus reading list) rather than
// brainstorming from scratch. See "Adapting This to Your Field" in README.md.
//
// HOW TERMS ARE MATCHED
//   - Case-insensitive, whole words only: "attack rate" will NOT match
//     inside "heart attack rates".
//   - Spaces and hyphens are interchangeable: "cross species transmission"
//     also matches "cross-species transmission".
//   - A trailing plural "s" is allowed: "reservoir host" also matches
//     "reservoir hosts". So write terms in the singular.
//   - Whole-word means "host jump" does NOT match "host jumping"; list
//     both if you want both.
//   - An entry can also be { label: '...', pattern: /regex/ } for cases a
//     plain phrase can't express (see 'contact tracing' below).
//
// When adding a term, put it in the tier that matches how specific it is:
// if it would mostly bring in noise on its own, it belongs in a context
// group, not in CORE_TOPICS.
//
// The lists below are an illustrative placeholder for an epidemiology /
// infectious-disease research area. Replace them entirely with your own
// field's vocabulary.

// (a) Count on their own.
const CORE_TOPICS = [
  'transmission dynamics',
  'basic reproduction number',
  'herd immunity threshold',
  'infection fatality rate',
  'seroprevalence',
  'zoonotic spillover',
  'antimicrobial resistance',
  'pandemic preparedness',
  // "contact tracing", but not "contact tracing app store review" style
  // software papers. Example of the {label, pattern} form.
  {
    label: 'contact tracing',
    pattern: /\bcontact[\s-]+tracing\b(?![\s-]+(apps?|software|api))/i,
  },
];

// What counts as "mentions your subject matter", for the context tier.
// Each named group is a list of regular expressions; a paper "mentions" the
// group if any one of them matches its title or abstract. Regular
// expressions (rather than plain phrases) so that you can match
// case-sensitively where needed, e.g. /\bHIV\b/ without the i flag.
//
// Give each group a short name — it is shown next to the matched term in
// the Sheet ("spillover [animals]"), so you can see why a paper counted.
const TOPIC_ANCHORS = {
  infection: [
    /\binfect(ions?|ious)\b/i,
    /\bpathogens?\b/i,
    /\bvirus(es)?\b/i,
    /\bviral\b/i,
    /\bbacteri(a|al|um)\b/i,
    /\b(epidemics?|pandemics?|outbreaks?)\b/i,
  ],
  animals: [
    /\b(non-?human )?animals?\b/i,
    /\b(wildlife|livestock|poultry|bats?|rodents?|mosquito(es)?|ticks?)\b/i,
  ],
};

// (b) Count only if the paper also mentions one of the group's anchors
// (ANY of them, not all).
const CONTEXT_TOPICS = [
  {
    anchors: ['infection'],
    terms: [
      'incubation period',
      'serial interval',
      'attack rate',
      'case fatality rate',
      'superspreading',
      'surveillance',
      'emergence',
    ],
  },
  {
    anchors: ['infection', 'animals'],
    terms: [
      'spillover',
      'reservoir host',
      'host jump',
      'cross species transmission',
    ],
  },
];

// Terms that are reliable only when they are prominent. A term listed here
// counts only if ANY of these holds:
//   - it appears in the TITLE (and, for context terms, the title also
//     mentions one of the term's anchors);
//   - for context terms: it appears within ANCHOR_PROXIMITY_WORDS words of
//     an anchor mention ("surveillance of the outbreak"), not just somewhere
//     else in the abstract;
//   - the paper matches at least one other, different term.
// Every other term still counts on a single match anywhere, because
// specific terms rarely appear in passing.
//
// Use this for terms you've seen matching papers that mention them once in
// passing: a broad policy term in an unrelated paper's closing sentence, a
// general word that also appears in the paper's anchor vocabulary.
//
// Weak terms also rank lowest (Context tier) in relevanceScore.gs.
const WEAK_TOPICS = [
  'pandemic preparedness',
  'surveillance',
  'emergence',
];

// How close (in words) a weak context term must be to an anchor mention to
// count on its own. See WEAK_TOPICS above.
const ANCHOR_PROXIMITY_WORDS = 6;

// ---------------------------------------------------------------------------
// 1B. FETCH QUERIES
// ---------------------------------------------------------------------------
//
// What fetchCrossref.gs and fetchOpenAlex.gs search for, one request per
// query per source. These are kept separate from the relevance rules above:
// using every relevance term as a query means many requests per run, and
// the generic terms return mostly noise anyway. Every result still has to
// pass the relevance rules, so these only need to cast the net, not decide
// relevance. Short, specific phrases work best.
//
// Illustrative placeholder, matching the epidemiology example above.
const FETCH_QUERIES = [
  'transmission dynamics',
  'basic reproduction number',
  'herd immunity threshold',
  'infection fatality rate',
  'seroprevalence',
  'zoonotic spillover',
  'antimicrobial resistance',
  'pandemic preparedness',
  'contact tracing',
  'serial interval epidemic',
  'superspreading',
];

// What fetchArxiv.gs searches for, across ALL of arXiv (title + abstract).
//
// arXiv can also be fetched by category (the newest papers in, say, cs.AI,
// whatever their topic), but that misses relevant work posted under other
// categories and fills the feed with unrelated papers from the chosen ones.
// Searching by phrase avoids both problems.
//
// Each entry is one of:
//   - a phrase: 'transmission dynamics'
//       matches papers with that exact phrase in the abstract.
//   - a list, meaning ALL parts must appear:
//       ['serial interval', ['epidemic', 'outbreak']]
//       = "serial interval" AND ("epidemic" OR "outbreak").
//     An inner list means ANY of those phrases.
//
// Results still have to pass the relevance rules in section 1; these only
// decide what arXiv hands back. Avoid very common phrases on their own —
// they can return hundreds of papers a week.
const OUTBREAK_WORDS = ['epidemic', 'epidemics', 'outbreak', 'outbreaks', 'pandemic'];
const ARXIV_QUERIES = [
  'transmission dynamics',
  'basic reproduction number',
  'herd immunity threshold',
  'infection fatality rate',
  'seroprevalence',
  'zoonotic spillover',
  'antimicrobial resistance',
  ['contact tracing', OUTBREAK_WORDS],
  ['serial interval', OUTBREAK_WORDS],
  ['superspreading', OUTBREAK_WORDS],
];

// ---------------------------------------------------------------------------
// 1C. FIELD VOCABULARY (RANKING BONUS)
// ---------------------------------------------------------------------------
//
// Words that indicate a paper is genuinely about your research area, as
// opposed to using field vocabulary incidentally. Used by relevanceScore.gs
// as a corroboration bonus: a paper matching a topic once in a passing
// sentence scores lower than one that also uses several of these words.
// Never used to reject a paper.
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
// 1D. LOW-QUALITY SOURCE FILTERS
// ---------------------------------------------------------------------------
//
// Topic matching lets through more than off-topic noise — it also lets
// through self-published, non-peer-reviewed content that happens to share
// your field's vocabulary. This has become a cross-disciplinary problem as
// it's gotten trivially easy to generate confident-sounding, jargon-heavy
// "papers" with no institutional review behind them. The filters below catch
// that category specifically, separately from ordinary topical relevance.
// Used by relevanceFilter.gs.

// DOI prefixes for repositories that accept anything with no review.
//   - Zenodo: self-deposits, indexed by OpenAlex indistinguishably from real
//     journal articles. Crossref-sourced records never carry this prefix
//     (Zenodo registers through DataCite, not Crossref), so this check is
//     safe to apply globally rather than gating it to a specific source.
//
// CAVEAT: some fields legitimately use Zenodo for citable software releases,
// datasets, or conference proceedings archives. If that's common in your
// field, this default will cost you real results — remove it or narrow it
// (e.g. only flag records that ALSO match a LOW_QUALITY_TEXT_PATTERNS entry).
//
// Figshare ('10.6084/m9.figshare') is a candidate for this list too: in one
// deployment every Figshare record that reached the Digest was a dataset or
// a self-published piece. It ships as a ranking penalty instead (see
// PREPRINT_DOI_PREFIXES) — uncomment below if you see the same pattern.
const BLOCKED_DOI_PREFIXES = [
  '10.5281/zenodo',
  // '10.6084/m9.figshare',
];

// Authors who've repeatedly self-published non-peer-reviewed content that
// matches your topics on vocabulary alone. Matched against lowercase author
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
// Note when and why each entry was added.
const AUTHOR_BLOCKLIST = [
  // 'surname, firstname', // YYYY-MM-DD: what you observed
];

// Title/abstract patterns strongly associated with self-published, non-
// peer-reviewed content rather than field scholarship. These are
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

// ---------------------------------------------------------------------------
// 1E. RANKING / SCORING SETTINGS
// ---------------------------------------------------------------------------
//
// Used by relevanceScore.gs. Every paper that survives the filter gets a
// numeric score and a tier, both written to the Digest sheet so the sheet can
// be sorted by relevance instead of only by date.
//
// Each matched term's ranking weight follows from where it sits in
// section 1:
//   core       — a CORE_TOPICS term
//   supporting — a CONTEXT_TOPICS term
//   context    — any term listed in WEAK_TOPICS (whichever list it is in)
//
// How the score is built, in plain terms:
//   - Each distinct matched term contributes points based on its weight.
//   - A term that appears in the TITLE counts double (titles are a much
//     stronger signal of subject matter than abstracts).
//   - Matching several core/supporting terms adds a small breadth bonus.
//   - Field vocabulary words (section 1C) add a bonus.
//   - Preprint/self-deposit DOIs and missing abstracts subtract a little.
//
// To make the Digest more selective, raise coreThreshold. To see more in the
// top tier, lower it. Nothing is ever deleted by these numbers.
const RELEVANCE_SCORING = {

  // Points per distinct matched term, by weight (see above).
  topicPoints: {
    core: 15,
    supporting: 6,
    context: 2,
  },

  // A term found in the title is worth this many times its normal points.
  titleMultiplier: 2,

  // Small bonus for matching several DIFFERENT core/supporting terms.
  // Deliberately excludes weak terms: rewarding breadth there would reward
  // exactly the "list every buzzword" pattern that marks self-published work.
  breadthBonusPerExtraTopic: 2,
  breadthBonusCap: 6,

  // Bonus per DISTINCT field vocabulary word found (section 1C).
  mindVocabBonusPerTerm: 2,
  mindVocabBonusCap: 8,

  // Penalties.
  noAbstractPenalty: 3,   // can't judge a paper we can't read
  preprintPenalty: 4,     // self-deposit repositories, see PREPRINT_DOI_PREFIXES

  // Tier cut-offs. A paper scores into the highest tier it clears.
  coreThreshold: 18,
  adjacentThreshold: 10,

  // Guard rails, applied AFTER the thresholds:
  //   - A paper that matched no core or supporting term can never reach the
  //     Core tier, however many weak terms it stacked up.
  //   - A paper with a real abstract needs at least this many distinct
  //     field vocabulary words to reach Core. This stops a title pun or a
  //     one-line mention from topping the sheet.
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
    // What to search for is ARXIV_QUERIES (section 1B). fetchArxiv.gs
    // combines several queries per request and waits 3 seconds between
    // requests, as arXiv asks.
    // Results per page, newest first. A batch keeps paging until it
    // reaches papers older than the lookback window, up to maxPages.
    pageSize: 100,
    maxPages: 3,
  },
  crossref: {
    // Max results per query in FETCH_QUERIES.
    rowsPerQuery: 20,
    // Crossref asks that you identify yourself — fill in a real contact.
    // This is NOT a credential, just an email string sent as a query param
    // so Crossref can reach you if something's wrong with your usage.
    politeEmail: 'YOUR_CONTACT_EMAIL@example.org',
    // Only these Crossref record types are requested. Leaves out datasets,
    // components, peer reviews, grants, and other records that aren't
    // papers. Crossref type names: https://api.crossref.org/types
    includeTypes: [
      'journal-article',
      'book-chapter',
      'book',
      'monograph',
      'edited-book',
      'posted-content',       // preprints
      'proceedings-article',
      'report',
      'dissertation',
    ],
  },
  philpapers: {
    maxResults: 50,
  },
  openalex: {
    // Max results per query in FETCH_QUERIES.
    maxResults: 25,
    // NOTE: OpenAlex deprecated the mailto "polite pool" system in Feb
    // 2026 — there is no email setting here anymore. Authentication is
    // now via API key, stored in Script Properties as OPENALEX_API_KEY
    // (NOT here — this file is fine to share/view, Script Properties
    // is the credential store). See fetchOpenAlex.gs's file header for
    // setup instructions if this hasn't been configured yet.
    // Only these OpenAlex work types are requested. Leaves out datasets,
    // "paratext" (calls for papers, front matter), editorials, errata,
    // letters, peer reviews, and "other". Type names:
    // https://docs.openalex.org/api-entities/works/work-object#type
    includeTypes: [
      'article',
      'preprint',
      'review',
      'book-chapter',
      'book',
      'report',
      'dissertation',
    ],
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
// Latest publication date to ask Crossref and OpenAlex for.
//
// Both fetchers sort newest-first, and without an upper bound the
// newest-first slots fill up with records carrying bogus future dates
// (Crossref "Title Pending" placeholders dated a decade ahead, records
// dated 2121, etc.), pushing real recent papers out of the result window.
// One year ahead still allows legitimate online-first papers that carry
// a future print-issue date.
// ---------------------------------------------------------------------------
const MAX_FUTURE_PUBLICATION_DAYS = 365;

/**
 * Returns the latest publication date (ISO 'YYYY-MM-DD') to request,
 * based on MAX_FUTURE_PUBLICATION_DAYS above.
 *
 * @return {string} e.g. '2027-09-29'
 */
function getPublicationDateCeiling() {
  const ceiling = new Date();
  ceiling.setDate(ceiling.getDate() + MAX_FUTURE_PUBLICATION_DAYS);
  return Utilities.formatDate(ceiling, Session.getScriptTimeZone(), 'yyyy-MM-dd');
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
