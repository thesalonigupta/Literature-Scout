/**
 * relevanceScore.gs
 *
 * Ranks papers that have already passed relevanceFilter.gs, so the Digest
 * sheet can be sorted by relevance rather than only by date.
 *
 * WHY THIS EXISTS
 * ---------------
 * The filter answers a yes/no question: is this paper plausibly about your
 * field's subject matter? That question turns out to be the wrong one for a
 * subset of what the Scout finds. Papers that a researcher wants to KEEP but
 * would never read in full — useful background, one-line-citation pieces,
 * adjacent work worth knowing about — can't be cleanly separated from
 * must-reads by vocabulary alone. Filtering those out loses them; leaving
 * them in unranked buries the papers that actually matter.
 *
 * So: the filter stays deliberately permissive, and this file sorts.
 * Nothing here ever removes a paper. Every function below only adds two
 * fields — `relevanceScore` (a number) and `relevanceTier` (a label).
 *
 * THE THREE TIERS
 * ---------------
 *   core      — read this. The paper's subject IS your field's central
 *               research question.
 *   adjacent  — skim this. Genuinely related, but your vocabulary may be
 *               doing supporting rather than central work.
 *   context   — file this. Useful background or a citable example at most.
 *
 * Tiers rather than a bare 0-100 number because a tier is something a
 * researcher can act on immediately, and because the tier labels stay
 * meaningful even after someone retunes the weights in config.gs.
 *
 * TUNING
 * ------
 * Every number this file uses lives in RELEVANCE_SCORING in config.gs, and
 * every topic's tier lives in TOPIC_TIER_* there. Nothing in this file needs
 * editing to change how papers rank. If you change the tier lists, run
 * validateTopicTiers() once to check nothing got left out.
 *
 * KNOWN LIMITATIONS
 * -----------------
 *  - This is keyword scoring, not comprehension. A paper whose title uses
 *    your field's vocabulary figuratively or as a pun can score into a
 *    higher tier than it deserves. The minMindVocabForCore guard catches
 *    most of these; it won't catch all.
 *  - The scoring weights in config.gs are a starting point calibrated for
 *    a field with a mix of core, supporting, and context terms. Your field
 *    may benefit from different weights — use explainScoreForSampleText()
 *    to see why individual papers scored the way they did, and adjust
 *    from there.
 */

/**
 * Scores and tiers a list of papers in place, then returns them sorted
 * highest-score-first. Called from main.gs between the relevance filter and
 * the Sheet write (if you add the call there — see main.gs).
 *
 * @param {NormalizedPaper[]} papers - Each must already have `matchedTopics`
 *        attached by relevanceFilter.gs.
 * @return {NormalizedPaper[]} The same papers, each with `relevanceScore`
 *         and `relevanceTier` added, sorted by score descending.
 */
function scoreAndTierPapers(papers) {
  papers.forEach(function(paper) {
    const result = scorePaper(paper, paper.matchedTopics || []);
    paper.relevanceScore = result.score;
    paper.relevanceTier = result.tier;
  });

  return papers.sort(function(a, b) {
    return b.relevanceScore - a.relevanceScore;
  });
}

/**
 * Computes one paper's relevance score and tier.
 *
 * Exposed separately from scoreAndTierPapers so it can be called on a single
 * paper — by the Sheet backfill in writeToSheet.gs, or by hand from the
 * editor when you're checking why something ranked where it did.
 *
 * @param {NormalizedPaper} paper
 * @param {string[]} matchedTopics
 * @return {{score: number, tier: string, breakdown: Object}}
 */
function scorePaper(paper, matchedTopics) {
  const weights = RELEVANCE_SCORING;
  const title = String(paper.title || '').toLowerCase();
  const abstract = String(paper.abstract || '');
  const haystack = (title + ' ' + abstract).toLowerCase();

  // Collapse variant forms so "transmission dynamics" + "dynamics of
  // transmission" counts once, not twice. Without this, every topic that
  // has a variant form in TOPICS would double its own score.
  const topics = dedupeNestedTopics(matchedTopics);

  let topicPoints = 0;
  let coreOrSupportingCount = 0;

  topics.forEach(function(topic) {
    const tier = getTopicTier(topic);
    let points = weights.topicPoints[tier] || weights.topicPoints.supporting;

    // A topic in the title is a much stronger signal than one buried in an
    // abstract — an abstract mentions many things, a title names the subject.
    if (title.indexOf(topic.toLowerCase()) !== -1) {
      points = points * weights.titleMultiplier;
    }

    topicPoints += points;

    if (tier === 'core' || tier === 'supporting') {
      coreOrSupportingCount++;
    }
  });

  // Breadth bonus, core/supporting topics only. See the comment on
  // breadthBonusPerExtraTopic in config.gs for why context topics are excluded.
  const breadthBonus = Math.min(
    Math.max(0, coreOrSupportingCount - 1) * weights.breadthBonusPerExtraTopic,
    weights.breadthBonusCap
  );

  // Field corroboration vocabulary bonus.
  const mindVocabCount = countMindVocabTerms(haystack);
  const mindVocabBonus = Math.min(
    mindVocabCount * weights.mindVocabBonusPerTerm,
    weights.mindVocabBonusCap
  );

  // Penalties.
  let penalties = 0;
  const hasRealAbstract = abstract.trim().length >= 100;
  if (!hasRealAbstract) {
    penalties += weights.noAbstractPenalty;
  }
  if (isPreprintDoi(paper.doi)) {
    penalties += weights.preprintPenalty;
  }

  const score = Math.max(0, topicPoints + breadthBonus + mindVocabBonus - penalties);

  const tier = assignTier(score, {
    coreOrSupportingCount: coreOrSupportingCount,
    mindVocabCount: mindVocabCount,
    hasRealAbstract: hasRealAbstract,
  });

  return {
    score: score,
    tier: tier,
    // Kept for debugging — log this when a paper ranks somewhere surprising
    // and you want to see which component is responsible.
    breakdown: {
      topics: topics,
      topicPoints: topicPoints,
      breadthBonus: breadthBonus,
      mindVocabCount: mindVocabCount,
      mindVocabBonus: mindVocabBonus,
      penalties: penalties,
    },
  };
}

/**
 * Turns a raw score into a tier label, applying the guard rails described in
 * RELEVANCE_SCORING (config.gs).
 *
 * @param {number} score
 * @param {{coreOrSupportingCount: number, mindVocabCount: number,
 *          hasRealAbstract: boolean}} signals
 * @return {string} 'core' | 'adjacent' | 'context'
 */
function assignTier(score, signals) {
  const weights = RELEVANCE_SCORING;

  let tier;
  if (score >= weights.coreThreshold) {
    tier = 'core';
  } else if (score >= weights.adjacentThreshold) {
    tier = 'adjacent';
  } else {
    tier = 'context';
  }

  if (tier !== 'core') return tier;

  // Guard 1: context-tier terms alone can never make a paper Core, no matter
  // how many of them stacked up. This is what keeps a paper naming many
  // context-tier terms out of the top of the sheet.
  if (signals.coreOrSupportingCount === 0) {
    return 'adjacent';
  }

  // Guard 2: a paper genuinely about your field uses more than one of your
  // field's core vocabulary words. A title using a keyword figuratively
  // typically uses exactly one. Only applied where there's enough text to
  // judge — papers with no abstract are still checked against their title.
  if (signals.mindVocabCount < weights.minMindVocabForCore) {
    return 'adjacent';
  }

  return 'core';
}

/**
 * Looks up which tier a topic belongs to. Anything missing from all three
 * lists in config.gs is treated as 'supporting' — a deliberate middle
 * default, so a newly-added topic someone forgot to tier neither disappears
 * nor dominates. validateTopicTiers() reports these.
 *
 * @param {string} topic
 * @return {string} 'core' | 'supporting' | 'context'
 */
function getTopicTier(topic) {
  if (TOPIC_TIER_CORE.indexOf(topic) !== -1) return 'core';
  if (TOPIC_TIER_CONTEXT.indexOf(topic) !== -1) return 'context';
  return 'supporting';
}

/**
 * Removes matched topics that are contained inside another matched topic, so
 * variant forms of the same idea only score once.
 *
 * Example: a paper matching 'transmission dynamics' and 'dynamics' both
 * would only count 'transmission dynamics' — the longer, more specific form.
 *
 * @param {string[]} topics
 * @return {string[]}
 */
function dedupeNestedTopics(topics) {
  const unique = [];

  topics.forEach(function(topic) {
    const lower = topic.toLowerCase();
    const isContainedInAnother = topics.some(function(other) {
      const otherLower = other.toLowerCase();
      return otherLower !== lower && otherLower.indexOf(lower) !== -1;
    });
    if (!isContainedInAnother && unique.indexOf(topic) === -1) {
      unique.push(topic);
    }
  });

  return unique;
}

/**
 * Counts how many DISTINCT MIND_VOCAB terms appear in the text. Distinct,
 * not total: a paper using one field vocabulary word nine times should not
 * out-score a paper that uses three different ones once each.
 *
 * @param {string} lowercaseText
 * @return {number}
 */
function countMindVocabTerms(lowercaseText) {
  let count = 0;

  MIND_VOCAB.forEach(function(term) {
    const pattern = new RegExp('\\b' + escapeRegExp(term) + '\\b', 'i');
    if (pattern.test(lowercaseText)) {
      count++;
    }
  });

  return count;
}

/**
 * True if a DOI belongs to a repository that publishes without peer review
 * (see PREPRINT_DOI_PREFIXES in config.gs). Costs a few points; never
 * rejects, because relevant preprints legitimately appear on all of them.
 *
 * @param {string|null} doi
 * @return {boolean}
 */
function isPreprintDoi(doi) {
  const normalized = String(doi || '').toLowerCase();
  if (!normalized) return false;

  return PREPRINT_DOI_PREFIXES.some(function(prefix) {
    return normalized.indexOf(prefix) === 0;
  });
}

/**
 * Escapes regex metacharacters in a literal string, so a vocabulary term
 * containing e.g. a hyphen or a period can't break the pattern it's built
 * into.
 *
 * @param {string} text
 * @return {string}
 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * MAINTENANCE HELPER — run this from the Apps Script editor after editing
 * any of the TOPIC_TIER_* lists in config.gs.
 *
 * Reports:
 *   - topics in TOPICS that aren't in any tier list (they'll default to
 *     'supporting', which may not be what you wanted)
 *   - topics in a tier list that are no longer in TOPICS (dead entries)
 *   - topics appearing in more than one tier list (the first match wins,
 *     which is almost certainly a mistake)
 *
 * Results go to View > Logs.
 */
function validateTopicTiers() {
  const untiered = TOPICS.filter(function(topic) {
    return TOPIC_TIER_CORE.indexOf(topic) === -1
      && TOPIC_TIER_SUPPORTING.indexOf(topic) === -1
      && TOPIC_TIER_CONTEXT.indexOf(topic) === -1;
  });

  const allTiered = [].concat(TOPIC_TIER_CORE, TOPIC_TIER_SUPPORTING, TOPIC_TIER_CONTEXT);

  const orphaned = allTiered.filter(function(topic) {
    return TOPICS.indexOf(topic) === -1;
  });

  const duplicated = allTiered.filter(function(topic, index) {
    return allTiered.indexOf(topic) !== index;
  });

  Logger.log('--- Topic tier validation ---');
  Logger.log('TOPICS: %s terms', TOPICS.length);
  Logger.log('  core: %s | supporting: %s | context: %s',
    TOPIC_TIER_CORE.length, TOPIC_TIER_SUPPORTING.length, TOPIC_TIER_CONTEXT.length);

  if (untiered.length === 0) {
    Logger.log('OK — every topic has a tier.');
  } else {
    Logger.log('NOT TIERED (defaulting to "supporting"): %s', untiered.join(', '));
  }

  if (orphaned.length > 0) {
    Logger.log('IN A TIER LIST BUT NOT IN TOPICS (dead entries): %s', orphaned.join(', '));
  }

  if (duplicated.length > 0) {
    Logger.log('IN MORE THAN ONE TIER LIST: %s', duplicated.join(', '));
  }
}

/**
 * MAINTENANCE HELPER — explains why one paper scored what it did.
 *
 * Paste a title and abstract in below and run it when a paper ranks
 * somewhere surprising, rather than guessing at the weights. Logs the
 * matched topics, each scoring component, and the final tier.
 */
function explainScoreForSampleText() {
  // ---- edit these two lines, then Run ----
  const title = 'Sample paper title here';
  const abstract = 'Paste the abstract text here to see how this paper would score.';
  // ----------------------------------------

  const paper = makeNormalizedPaper({
    title: title,
    authors: 'manual test',
    abstract: abstract,
    link: '',
    source: 'manual',
    publishedDate: '',
  });

  const relevance = checkRelevance(paper);
  const scored = scorePaper(paper, relevance.matchedTopics);

  Logger.log('Passed filter: %s', relevance.isRelevant);
  Logger.log('Matched topics: %s', relevance.matchedTopics.join(', ') || '(none)');
  Logger.log('Scored topics (after variant collapse): %s', scored.breakdown.topics.join(', ') || '(none)');
  Logger.log('  topic points:          %s', scored.breakdown.topicPoints);
  Logger.log('  breadth bonus:         %s', scored.breakdown.breadthBonus);
  Logger.log('  field vocab words:     %s (bonus %s)', scored.breakdown.mindVocabCount, scored.breakdown.mindVocabBonus);
  Logger.log('  penalties:             -%s', scored.breakdown.penalties);
  Logger.log('TOTAL: %s  ->  tier: %s', scored.score, scored.tier);
}
