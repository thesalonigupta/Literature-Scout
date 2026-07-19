/**
 * relevanceFilter.gs
 *
 * Cheap, no-LLM relevance check: does a paper's title or abstract contain
 * at least one of TOPICS (defined in config.gs)? Simple OR-match —
 * see config.gs for the reasoning on why OR rather than AND.
 *
 * This intentionally runs AFTER dedupe.gs, not before — checking "have I
 * seen this?" is a cheap Set lookup, while scanning title+abstract text
 * against a keyword list is comparatively more work. No point spending that
 * effort on a paper we're about to discard as a duplicate anyway.
 *
 * This is NOT meant to be precise. It exists to keep obvious noise out of
 * the Sheet and Slack feed. A downstream triage or relevance-ranking step
 * does the real scoring against your active research questions.
 *
 * AMBIGUOUS TOPICS:
 * Some TOPICS entries are everyday words shared with unrelated fields,
 * where a plain OR-match produces clear, common false positives. For terms
 * listed in AMBIGUOUS_TOPICS below, a match on that term ALONE is not
 * sufficient — the paper must also match at least one OTHER TOPICS term to
 * count as relevant. This is a narrow, deliberately small exception list,
 * not a general switch to AND-logic — see config.gs's reasoning for why OR
 * remains the default for everything else. Add a term here only after
 * observing it produce a genuine off-topic false positive in a real run,
 * not preemptively.
 */

// Topics that need a second, independent TOPICS match to count.
// Each entry here should have a one-line reason — what false positive
// was observed, and when — so future maintainers know why it's here and
// can reconsider if the term's behavior changes.
//
// These are illustrative placeholder examples. Replace them with terms
// from your own TOPICS list that you have observed producing false positives.
const AMBIGUOUS_TOPICS = [
  'spillover',  // 2026-01-15: matched finance/economics articles on earnings spillover and market contagion — the word has a separate meaning in that literature
  'emergence',  // 2026-01-15: matched philosophy and complexity-theory papers using emergence as a general concept — too common outside the target field when appearing alone
];

/**
 * Checks a single NormalizedPaper against TOPICS.
 *
 * @param {NormalizedPaper} paper
 * @return {{isRelevant: boolean, matchedTopics: string[]}}
 */
function checkRelevance(paper) {
  const haystack = (paper.title + ' ' + paper.abstract).toLowerCase();
  const matchedTopics = [];

  TOPICS.forEach(function(topic) {
    if (haystack.indexOf(topic.toLowerCase()) !== -1) {
      matchedTopics.push(topic);
    }
  });

  const isRelevant = matchedTopics.some(function(topic) {
    return isUnambiguousMatch(topic, matchedTopics);
  });

  return {
    isRelevant: isRelevant,
    matchedTopics: matchedTopics,
  };
}

/**
 * A single matched topic counts on its own UNLESS it's in
 * AMBIGUOUS_TOPICS, in which case it only counts if at least one OTHER
 * matched topic is present alongside it.
 *
 * @param {string} topic - One topic that matched.
 * @param {string[]} allMatchedTopics - Every topic that matched this paper.
 * @return {boolean}
 */
function isUnambiguousMatch(topic, allMatchedTopics) {
  if (AMBIGUOUS_TOPICS.indexOf(topic) === -1) {
    return true; // not ambiguous — matching on its own is fine, as before
  }
  // Ambiguous topic: only counts if some OTHER matched topic exists.
  return allMatchedTopics.some(function(other) {
    return other !== topic;
  });
}

/**
 * Filters a list of NormalizedPapers down to only the relevant ones, and
 * attaches the matched topic list to each surviving paper (as
 * `matchedTopics`) so writeToSheet.gs / postToSlack.gs can display WHY a
 * paper was flagged, not just that it was.
 *
 * @param {NormalizedPaper[]} papers
 * @return {NormalizedPaper[]} Relevant papers only, each with a
 *         `matchedTopics: string[]` field added.
 */
function filterToRelevantPapers(papers) {
  const relevant = [];

  papers.forEach(function(paper) {
    const result = checkRelevance(paper);
    if (result.isRelevant) {
      paper.matchedTopics = result.matchedTopics;
      relevant.push(paper);
    }
  });

  return relevant;
}
