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
 *
 * LOW-QUALITY SOURCES: plain topic OR-matching also lets through self-
 * published, non-peer-reviewed content that happens to share your field's
 * vocabulary. Two mechanisms address this, both configured in config.gs
 * and both empty/off by default until you populate them for your field:
 *   - isLowQualitySource() rejects known-bad DOI prefixes (Zenodo, on by
 *     default — see caveat in config.gs), blocklisted repeat-offender
 *     authors, and vanity-press text patterns.
 *   - THEORY_ONLY_TOPICS + hasAppliedTopicMatch() require a pure theory/
 *     mechanism topic match to be paired with a topic OUTSIDE that list.
 *     Pairing two theory-only topics with each other does NOT satisfy
 *     this — that combination is exactly what self-published "unified
 *     theory" content tends to pack in.
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

  const hasUnambiguousMatch = matchedTopics.some(function(topic) {
    return isUnambiguousMatch(topic, matchedTopics);
  });

  const isRelevant = hasUnambiguousMatch
    && hasAppliedTopicMatch(matchedTopics)
    && !isLowQualitySource(paper);

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
 * True if the paper matches at least one TOPICS term that is NOT in
 * THEORY_ONLY_TOPICS (config.gs). A paper matching ONLY theory-only terms —
 * however many, however they pair with each other — does not count. See
 * THEORY_ONLY_TOPICS's comment in config.gs for why. Ships as a no-op
 * (always returns true) until THEORY_ONLY_TOPICS is populated.
 *
 * @param {string[]} matchedTopics
 * @return {boolean}
 */
function hasAppliedTopicMatch(matchedTopics) {
  return matchedTopics.some(function(topic) {
    return THEORY_ONLY_TOPICS.indexOf(topic) === -1;
  });
}

/**
 * True if the paper looks like self-published, non-peer-reviewed content
 * rather than field scholarship: a Zenodo self-deposit, a blocklisted
 * repeat-offender author, or a title/abstract matching one of
 * LOW_QUALITY_TEXT_PATTERNS (all configured in config.gs).
 *
 * @param {NormalizedPaper} paper
 * @return {boolean}
 */
function isLowQualitySource(paper) {
  const doi = (paper.doi || '').toLowerCase();
  const isBlockedDoi = BLOCKED_DOI_PREFIXES.some(function(prefix) {
    return doi.indexOf(prefix) === 0;
  });
  if (isBlockedDoi) return true;

  // paper.authors may be a joined string or an array depending on what
  // normalize.gs produced — handle either defensively.
  const authorText = [].concat(paper.authors || '').join(' ').toLowerCase();
  const isBlockedAuthor = AUTHOR_BLOCKLIST.some(function(blocked) {
    return authorText.indexOf(blocked) !== -1;
  });
  if (isBlockedAuthor) return true;

  const text = (paper.title + ' ' + paper.abstract).toLowerCase();
  const matchesLowQualityPattern = LOW_QUALITY_TEXT_PATTERNS.some(function(pattern) {
    return pattern.test(text);
  });
  if (matchesLowQualityPattern) return true;

  return false;
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
