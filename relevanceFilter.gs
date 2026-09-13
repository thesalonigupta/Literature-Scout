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
 * This is NOT meant to be precise. Its only job is keeping obvious noise out
 * of the Sheet. Everything it lets through is then RANKED by
 * relevanceScore.gs, which sorts borderline material to the bottom of the
 * Digest instead of deleting it. When you're deciding whether to add a rule
 * here or a weight in relevanceScore.gs, prefer the weight: a rejection is
 * invisible and unauditable, a low score is neither.
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
 * GATED TOPICS:
 * Some TOPICS terms are standard vocabulary in fields unrelated to yours.
 * Unlike ambiguous terms (which just need any second topic to corroborate
 * them), gated terms can also be corroborated by field-specific vocabulary
 * from GATE_CORROBORATION_TERMS in config.gs, even without a second topic
 * match. Use this when the term appears in genuinely relevant papers that
 * only use one of your TOPICS terms but use your field's core vocabulary
 * throughout. See config.gs section 1C.
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

  // Topics that actually COUNT toward relevance, after the ambiguous-term
  // and gated-term rules. The full matchedTopics list is still returned and
  // written to the Sheet — a maintainer looking at a surprising row wants to
  // see everything that matched, including the terms that didn't count.
  const countableTopics = matchedTopics.filter(function(topic) {
    return isCountableMatch(topic, matchedTopics, haystack);
  });

  let isRelevant = countableTopics.length > 0
    && !isLowQualitySource(paper)
    && !isBoilerplateOnlyMatch(paper, matchedTopics);

  if (isRelevant && FILTER_TOGGLES.rejectTheoryOnlyPapers) {
    isRelevant = hasAppliedTopicMatch(matchedTopics);
  }

  if (isRelevant && FILTER_TOGGLES.rejectPolicyOnlyPapers) {
    isRelevant = !matchesOnlyContextTierTopics(matchedTopics);
  }

  return {
    isRelevant: isRelevant,
    matchedTopics: matchedTopics,
  };
}

/**
 * Decides whether one matched topic counts toward relevance on its own.
 *
 * Three cases:
 *   - A gated topic (config.gs GATED_TOPICS) counts only if corroborated.
 *   - An ambiguous topic counts only if some OTHER topic also matched.
 *   - Everything else counts as it always has.
 *
 * @param {string} topic - One topic that matched.
 * @param {string[]} allMatchedTopics - Every topic that matched this paper.
 * @param {string} haystack - Lowercased title + abstract.
 * @return {boolean}
 */
function isCountableMatch(topic, allMatchedTopics, haystack) {
  if (FILTER_TOGGLES.enforceGatedTopics && GATED_TOPICS.indexOf(topic) !== -1) {
    return isGatedTopicCorroborated(topic, allMatchedTopics, haystack);
  }

  return isUnambiguousMatch(topic, allMatchedTopics);
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
 * A gated topic counts only if the paper gives some independent sign that
 * it's about your field. Either is enough:
 *
 *   (a) the text contains a GATE_CORROBORATION_TERM (config.gs section 1C),
 *       or
 *   (b) the paper also matched a TOPICS term that isn't itself gated.
 *
 * Condition (b) matters more than it looks: it's what keeps papers that
 * discuss your topic through related language from being dropped for
 * using no corroboration vocabulary in their abstract.
 *
 * @param {string} topic
 * @param {string[]} allMatchedTopics
 * @param {string} haystack - Lowercased title + abstract.
 * @return {boolean}
 */
function isGatedTopicCorroborated(topic, allMatchedTopics, haystack) {
  const hasCorroboratingVocabulary = GATE_CORROBORATION_TERMS.some(function(term) {
    return new RegExp('\\b' + escapeRegExp(term) + '\\b', 'i').test(haystack);
  });
  if (hasCorroboratingVocabulary) return true;

  return allMatchedTopics.some(function(other) {
    return other !== topic && GATED_TOPICS.indexOf(other) === -1;
  });
}

/**
 * True if the paper matches at least one TOPICS term that is NOT in
 * THEORY_ONLY_TOPICS (config.gs). A paper matching ONLY theory-only terms —
 * however many, however they pair with each other — does not count. See
 * THEORY_ONLY_TOPICS's comment in config.gs for why. Ships as a no-op
 * (always returns true) until THEORY_ONLY_TOPICS is populated.
 *
 * Only consulted when FILTER_TOGGLES.rejectTheoryOnlyPapers is true.
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
 * True if every matched topic is context-tier. Used when
 * FILTER_TOGGLES.rejectPolicyOnlyPapers is enabled — papers matching only
 * context-tier terms are de-prioritised by ranking rather than deleted by
 * default, but this toggle lets you reject them outright if context-tier
 * noise is still too high in your sheet.
 *
 * @param {string[]} matchedTopics
 * @return {boolean}
 */
function matchesOnlyContextTierTopics(matchedTopics) {
  if (!matchedTopics || matchedTopics.length === 0) return false;

  return matchedTopics.every(function(topic) {
    return getTopicTier(topic) === 'context';
  });
}

/**
 * True if the paper looks like self-published, non-peer-reviewed content
 * rather than field scholarship: a blocked DOI prefix, a blocklisted
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
 * True if the paper's only reason for matching TOPICS is boilerplate
 * sentences (ethics declarations, compliance statements, methodology
 * disclaimers) rather than the topic actually being the paper's subject.
 * Only rejects when ALL of: (a) every matched topic is in
 * BOILERPLATE_CONTEXT_TOPICS, (b) the text matches a
 * BOILERPLATE_CONTEXT_PATTERNS entry, AND (c) no field-core language
 * is present. Ships as a no-op until both lists are populated in config.gs.
 *
 * @param {NormalizedPaper} paper
 * @param {string[]} matchedTopics
 * @return {boolean}
 */
function isBoilerplateOnlyMatch(paper, matchedTopics) {
  if (!BOILERPLATE_CONTEXT_TOPICS || BOILERPLATE_CONTEXT_TOPICS.length === 0) return false;

  const onlyBoilerplateTopicsMatched = matchedTopics.every(function(topic) {
    return BOILERPLATE_CONTEXT_TOPICS.indexOf(topic) !== -1;
  });
  if (!onlyBoilerplateTopicsMatched) return false;

  if (!BOILERPLATE_CONTEXT_PATTERNS || BOILERPLATE_CONTEXT_PATTERNS.length === 0) return false;

  const text = (paper.title + ' ' + paper.abstract).toLowerCase();

  const hasBoilerplateLanguage = BOILERPLATE_CONTEXT_PATTERNS.some(function(pattern) {
    return pattern.test(text);
  });
  if (!hasBoilerplateLanguage) return false;

  // Check for field-core language that would indicate the paper is genuinely
  // about the topic rather than just mentioning it in a compliance sentence.
  // Populate this list with terms specific to your field's actual subject
  // matter — words that appear in papers ABOUT the topic, not just adjacent to it.
  const fieldCoreTerms = MIND_VOCAB || [];
  const hasFieldCoreLanguage = fieldCoreTerms.some(function(term) {
    return new RegExp('\\b' + escapeRegExp(term) + '\\b', 'i').test(text);
  });
  if (hasFieldCoreLanguage) return false;

  return true;
}

/**
 * Filters a list of NormalizedPapers down to only the relevant ones, and
 * attaches the matched topic list to each surviving paper (as
 * `matchedTopics`) so relevanceScore.gs / writeToSheet.gs / postToSlack.gs
 * can display WHY a paper was flagged, not just that it was.
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
