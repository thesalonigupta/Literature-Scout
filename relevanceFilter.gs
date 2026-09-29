/**
 * relevanceFilter.gs
 *
 * Cheap, no-LLM relevance check using the rules configured in config.gs
 * (section 1):
 *
 *   (a) a CORE_TOPICS term on its own, or
 *   (b) a CONTEXT_TOPICS term plus a mention of one of that term's anchors
 *       (TOPIC_ANCHORS),
 *
 * where terms in WEAK_TOPICS count only if they're prominent (in the title,
 * next to an anchor mention, or alongside another matched term), and the
 * paper is not from a low-quality source (config.gs section 1D).
 *
 * Why context tiers rather than a flat OR-list with exceptions: a flat list
 * lets in papers that use one of your terms in an unrelated sense, and the
 * usual fix is a growing pile of special cases (terms that need a second
 * match, terms that need corroborating vocabulary, terms that only count
 * outside boilerplate sentences). Each of those is really a term that only
 * matters in a particular context. The context tier handles that directly:
 *   - "spillover" in an economics paper: no infection or animal mention, so
 *     no match.
 *   - "emergence" in a complexity-theory paper: no infection mention, so no
 *     match.
 *   - "surveillance" mentioned once, far from any infection vocabulary, in a
 *     paper matching nothing else: a weak term out of context, so no match.
 *
 * This is NOT meant to be precise. Its only job is keeping obvious noise out
 * of the Sheet. Everything it lets through is then RANKED by
 * relevanceScore.gs, which sorts borderline material to the bottom of the
 * Digest instead of deleting it. When you're deciding whether to tighten a
 * rule here or change a weight in relevanceScore.gs, prefer the weight: a
 * rejection is invisible and unauditable, a low score is neither.
 *
 * Runs AFTER dedupe.gs, so no effort is spent on papers about to be
 * discarded as duplicates.
 *
 * Term patterns are compiled once per script execution (see
 * getCompiledTopicTiers) rather than once per paper.
 */

// Cache for compiled patterns. Apps Script re-runs top-level code on each
// execution, so this resets naturally between runs.
let COMPILED_TOPIC_TIERS_ = null;

/**
 * Checks a single NormalizedPaper against the relevance rules.
 *
 * @param {NormalizedPaper} paper
 * @return {{isRelevant: boolean, matchedTopics: string[], matches: Object[]}}
 *         matchedTopics lists the terms that matched (plus, for context-tier
 *         matches, which anchors were present), for display in the Sheet and
 *         Slack. matches is the same list in structured form, for
 *         relevanceScore.gs.
 */
function checkRelevance(paper) {
  const result = evaluateRelevanceText(paper.title, paper.abstract);
  return {
    isRelevant: result.isRelevant && !isLowQualitySource(paper),
    matchedTopics: result.matchedTopics,
    matches: result.matches,
  };
}

/**
 * The topic rules on their own, with no source-quality check. Takes plain
 * text so fetchers (e.g. fetchPhilPapers.gs) can use the same rules to
 * pre-filter raw records before normalizing them.
 *
 * Step 1 finds every matching term across title + abstract, using the
 * tiers in config.gs. Step 2 applies WEAK_TOPICS: a weak term only counts if
 * it is in the title, OR (for context terms) it sits within
 * ANCHOR_PROXIMITY_WORDS words of an anchor mention, OR the paper also
 * matches another, different term.
 *
 * @param {string} title
 * @param {string} abstract
 * @return {{isRelevant: boolean, matchedTopics: string[], matches: Array<{
 *   label: string, display: string, tier: string, weak: boolean,
 *   titleHit: boolean
 * }>}} tier is 'core' or 'context'. titleHit is true if the term itself
 *   appears in the title.
 */
function evaluateRelevanceText(title, abstract) {
  const titleText = String(title || '');
  const text = titleText + ' \n ' + String(abstract || '');
  const tiers = getCompiledTopicTiers();

  // Each match: {label, display, tier, weak, titleHit, inTitle, nearAnchor}
  const matches = [];

  tiers.core.forEach(function(term) {
    if (!term.pattern.test(text)) return;
    const titleHit = term.pattern.test(titleText);
    matches.push({
      label: term.label,
      display: term.label,
      tier: 'core',
      weak: isWeakTopic(term.label),
      titleHit: titleHit,
      inTitle: titleHit,
      nearAnchor: false,
    });
  });

  tiers.context.forEach(function(group) {
    const presentAnchors = group.anchors.filter(function(name) {
      return testAny(group.anchorPatterns[name], text);
    });
    if (presentAnchors.length === 0) return;

    const titleHasAnchor = group.anchors.some(function(name) {
      return testAny(group.anchorPatterns[name], titleText);
    });
    const anchorPatterns = presentAnchors.reduce(function(all, name) {
      return all.concat(group.anchorPatterns[name]);
    }, []);

    group.terms.forEach(function(term) {
      if (!term.pattern.test(text)) return;
      const titleHit = term.pattern.test(titleText);
      matches.push({
        label: term.label,
        display: term.label + ' [' + presentAnchors.join(' + ') + ']',
        tier: 'context',
        weak: isWeakTopic(term.label),
        titleHit: titleHit,
        inTitle: titleHit && titleHasAnchor,
        nearAnchor: isNearAnchorMention(text, term.pattern, anchorPatterns),
      });
    });
  });

  const hasSeveralTerms = matches.length >= 2;
  const counted = matches.filter(function(match) {
    return !match.weak || match.inTitle || match.nearAnchor || hasSeveralTerms;
  });

  return {
    isRelevant: counted.length > 0,
    matchedTopics: matches.map(function(match) { return match.display; }),
    matches: matches.map(function(match) {
      return {
        label: match.label,
        display: match.display,
        tier: match.tier,
        weak: match.weak,
        titleHit: match.titleHit,
      };
    }),
  };
}

/**
 * True if some occurrence of `termPattern` in `text` is within
 * ANCHOR_PROXIMITY_WORDS words of some match of `anchorPatterns`. Catches
 * "surveillance of the outbreak", while a paper that mentions an outbreak in
 * a separate sentence does not count.
 *
 * @param {string} text
 * @param {RegExp} termPattern
 * @param {RegExp[]} anchorPatterns
 * @return {boolean}
 */
function isNearAnchorMention(text, termPattern, anchorPatterns) {
  const termWords = wordPositions(text, termPattern);
  if (termWords.length === 0) return false;

  const anchorWords = [];
  anchorPatterns.forEach(function(anchor) {
    anchorWords.push.apply(anchorWords, wordPositions(text, anchor));
  });

  return termWords.some(function(termWord) {
    return anchorWords.some(function(anchorWord) {
      return Math.abs(termWord - anchorWord) <= ANCHOR_PROXIMITY_WORDS;
    });
  });
}

/**
 * Word index (0-based) of the start of every match of `pattern` in `text`.
 *
 * @param {string} text
 * @param {RegExp} pattern
 * @return {number[]}
 */
function wordPositions(text, pattern) {
  const flags = pattern.flags.indexOf('g') === -1 ? pattern.flags + 'g' : pattern.flags;
  const globalPattern = new RegExp(pattern.source, flags);
  const positions = [];
  let match;
  while ((match = globalPattern.exec(text)) !== null) {
    const before = text.slice(0, match.index).trim();
    positions.push(before ? before.split(/\s+/).length : 0);
    if (match[0].length === 0) globalPattern.lastIndex++;
  }
  return positions;
}

/**
 * True if `label` is listed in WEAK_TOPICS (config.gs).
 *
 * @param {string} label
 * @return {boolean}
 */
function isWeakTopic(label) {
  return WEAK_TOPICS.some(function(weak) {
    return String(weak).trim().toLowerCase() === label.toLowerCase();
  });
}

/**
 * True if any of the regular expressions matches `text`.
 *
 * @param {RegExp[]} patterns
 * @param {string} text
 * @return {boolean}
 */
function testAny(patterns, text) {
  return (patterns || []).some(function(re) { return re.test(text); });
}

/**
 * Compiles the topic lists in config.gs into regular expressions, once per
 * execution.
 *
 * @return {{core: Array, context: Array}}
 */
function getCompiledTopicTiers() {
  if (!COMPILED_TOPIC_TIERS_) {
    COMPILED_TOPIC_TIERS_ = {
      core: CORE_TOPICS.map(compileTopicTerm),
      context: CONTEXT_TOPICS.map(function(group) {
        const anchorPatterns = {};
        group.anchors.forEach(function(name) {
          if (!TOPIC_ANCHORS[name]) {
            Logger.log('relevanceFilter: CONTEXT_TOPICS refers to anchor group "%s", ' +
              'which is not defined in TOPIC_ANCHORS (config.gs).', name);
          }
          anchorPatterns[name] = TOPIC_ANCHORS[name] || [];
        });
        return {
          anchors: group.anchors,
          anchorPatterns: anchorPatterns,
          terms: group.terms.map(compileTopicTerm),
        };
      }),
    };
  }
  return COMPILED_TOPIC_TIERS_;
}

/**
 * Turns one config.gs topic entry into {label, pattern}.
 *
 * A plain string becomes a case-insensitive, whole-word pattern in which
 * spaces and hyphens are interchangeable and a trailing "s" is optional:
 *   'reservoir host'  ->  /\breservoir[\s-]+hosts?\b/i
 * An entry that is already {label, pattern} is used as is.
 *
 * @param {string|{label: string, pattern: RegExp}} entry
 * @return {{label: string, pattern: RegExp}}
 */
function compileTopicTerm(entry) {
  if (typeof entry === 'object' && entry.pattern) {
    return { label: entry.label, pattern: entry.pattern };
  }

  const label = String(entry).trim().toLowerCase();
  const words = label.split(/[\s-]+/).map(escapeRegExp);
  const lastIndex = words.length - 1;
  if (!/s$/.test(words[lastIndex])) {
    words[lastIndex] += 's?';
  }

  return {
    label: label,
    pattern: new RegExp('\\b' + words.join('[\\s-]+') + '\\b', 'i'),
  };
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

  const text = String(paper.title || '') + ' ' + String(paper.abstract || '');
  return LOW_QUALITY_TEXT_PATTERNS.some(function(pattern) {
    return pattern.test(text);
  });
}

/**
 * Filters a list of NormalizedPapers down to only the relevant ones, and
 * attaches the matched topic list to each surviving paper (as
 * `matchedTopics`, plus the structured `relevanceMatches`) so
 * relevanceScore.gs / writeToSheet.gs / postToSlack.gs can show WHY a paper
 * was flagged, not just that it was.
 *
 * @param {NormalizedPaper[]} papers
 * @return {NormalizedPaper[]} Relevant papers only, each with
 *         `matchedTopics: string[]` and `relevanceMatches: Object[]` added.
 */
function filterToRelevantPapers(papers) {
  const relevant = [];

  papers.forEach(function(paper) {
    const result = checkRelevance(paper);
    if (result.isRelevant) {
      paper.matchedTopics = result.matchedTopics;
      paper.relevanceMatches = result.matches;
      relevant.push(paper);
    }
  });

  return relevant;
}
