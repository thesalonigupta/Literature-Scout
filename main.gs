/**
 * main.gs
 *
 * The orchestrator. This is the ONLY function a time-based trigger should
 * call (runLiteratureScout). Every other file holds reusable pieces;
 * this file just calls them in the right order:
 *
 *   1. Fetch candidates from every enabled source (config.gs toggles)
 *   2. Dedupe against the Sheet + within this batch (dedupe.gs)
 *   3. Filter to relevant papers only (relevanceFilter.gs), then score
 *      and sort them by relevance (relevanceScore.gs)
 *   4. Write surviving papers to the Sheet (writeToSheet.gs)
 *   5. Post surviving papers to Slack (postToSlack.gs) — no-op unless
 *      SLACK.enabled is true in config.gs (see postToSlack.gs for setup)
 *   6. Log the run's outcome to the Run Log tab, for debugging
 */

/**
 * Entry point. Set a time-based trigger (Apps Script editor > Triggers >
 * Add Trigger > choose this function > select a schedule) to run this
 * automatically, e.g. weekly.
 */
function runLiteratureScout() {
  const runStartedAt = new Date();
  const errors = [];
  let candidates = [];

  // --- Step 1: Fetch from every enabled source ---
  if (SOURCES_ENABLED.arxiv) {
    candidates = candidates.concat(safelyFetch('arxiv', fetchArxiv, errors));
  }
  if (SOURCES_ENABLED.crossref) {
    candidates = candidates.concat(safelyFetch('crossref', fetchCrossref, errors));
  }
  if (SOURCES_ENABLED.philpapers) {
    candidates = candidates.concat(safelyFetch('philpapers', fetchPhilPapers, errors));
  }
  if (SOURCES_ENABLED.openalex) {
    candidates = candidates.concat(safelyFetch('openalex', fetchOpenAlex, errors));
  }

  // --- Step 2: Dedupe (against Sheet history + within this batch) ---
  const newPapers = filterToNewPapers(candidates);

  // --- Step 3: Relevance filter, then ranking ---
  // Scoring never removes a paper; it adds relevanceScore / relevanceTier
  // (written to the Digest, and used by SLACK.minTierForIndividualPosts)
  // and sorts the list highest-score-first.
  const relevantNewPapers = scoreAndTierPapers(filterToRelevantPapers(newPapers));

  // --- Step 4: Write to Sheet ---
  appendPapersToDigest(relevantNewPapers);

  // --- Step 5: Post to Slack ---
  // No-op (returns []) unless SLACK.enabled is true in config.gs — see
  // postToSlack.gs for one-time setup. Posts the SAME list just written to
  // the Sheet, so Slack and the Digest tab never disagree about what's new.
  const slackErrors = postPapersToSlack(relevantNewPapers);
  slackErrors.forEach(function(message) {
    errors.push(message);
  });

  // --- Step 6: Log the run ---
  logRun({
    startedAt: runStartedAt,
    finishedAt: new Date(),
    candidatesFound: candidates.length,
    newAfterDedupe: newPapers.length,
    relevantAfterFilter: relevantNewPapers.length,
    errors: errors,
  });
}

/**
 * Wraps a fetch*.gs call so that one source failing (network error,
 * unexpected API response shape, etc.) doesn't take down the entire run.
 * Logs the failure and returns an empty array so the pipeline continues
 * with whatever sources DID succeed.
 *
 * @param {string} sourceName - For logging only, e.g. 'arxiv'.
 * @param {Function} fetchFn - One of fetchArxiv, fetchCrossref, etc.
 * @param {Array} errors - Mutated in place; failures get pushed here for
 *        the Run Log.
 * @return {NormalizedPaper[]}
 */
function safelyFetch(sourceName, fetchFn, errors) {
  try {
    return fetchFn();
  } catch (err) {
    const message = sourceName + ' failed: ' + err;
    Logger.log('safelyFetch: %s', message);
    errors.push(message);
    return [];
  }
}

/**
 * Appends one row to the Run Log tab summarizing what happened in a run.
 * This is the first place to look if "nothing showed up" — it tells you
 * whether sources returned candidates at all, and how many were filtered
 * out at each stage, without needing to dig through Apps Script's
 * execution logs (which only retain recent runs).
 *
 * @param {{startedAt: Date, finishedAt: Date, candidatesFound: number,
 *          newAfterDedupe: number, relevantAfterFilter: number,
 *          errors: string[]}} summary
 */
function logRun(summary) {
  const sheet = getRunLogSheet();
  const tz = Session.getScriptTimeZone();

  const row = [
    Utilities.formatDate(summary.startedAt, tz, 'yyyy-MM-dd HH:mm:ss'),
    Math.round((summary.finishedAt - summary.startedAt) / 1000) + 's',
    summary.candidatesFound,
    summary.newAfterDedupe,
    summary.relevantAfterFilter,
    summary.errors.length > 0 ? summary.errors.join(' | ') : '',
  ];

  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
}

const RUN_LOG_HEADERS = [
  'Run Started',
  'Duration',
  'Candidates Found',
  'New After Dedupe',
  'Relevant After Filter',
  'Errors',
];

/**
 * Gets the Run Log sheet, creating it (with headers) if it doesn't exist.
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getRunLogSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_TABS.runLog);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_TABS.runLog);
    sheet.getRange(1, 1, 1, RUN_LOG_HEADERS.length).setValues([RUN_LOG_HEADERS]);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

/**
 * Convenience function for manual testing from the Apps Script editor:
 * runs the full pipeline but logs candidate counts per source to the
 * Apps Script execution log (View > Logs) instead of writing anything,
 * so you can sanity-check each source independently before trusting the
 * full pipeline. Does NOT write to the Sheet or affect dedupe history.
 */
function testFetchAllSourcesWithoutWriting() {
  if (SOURCES_ENABLED.arxiv) {
    Logger.log('arxiv: %s candidates', fetchArxiv().length);
  }
  if (SOURCES_ENABLED.crossref) {
    Logger.log('crossref: %s candidates', fetchCrossref().length);
  }
  if (SOURCES_ENABLED.philpapers) {
    Logger.log('philpapers: %s candidates', fetchPhilPapers().length);
  }
  if (SOURCES_ENABLED.openalex) {
    Logger.log('openalex: %s candidates', fetchOpenAlex().length);
  }
}

/**
 * Convenience function for manual testing: runs fetch, dedupe, and the
 * relevance filter and ranking exactly as runLiteratureScout does, then logs
 * every paper that WOULD be added, with its tier, score and matched topics. Writes nothing to the Sheet
 * and posts nothing to Slack, so it can be run as often as you like.
 *
 * Use it after editing the topic lists in config.gs to see what the change
 * does before committing to a real run.
 */
function previewRelevantPapers() {
  const errors = [];
  let candidates = [];

  if (SOURCES_ENABLED.arxiv) {
    candidates = candidates.concat(safelyFetch('arxiv', fetchArxiv, errors));
  }
  if (SOURCES_ENABLED.crossref) {
    candidates = candidates.concat(safelyFetch('crossref', fetchCrossref, errors));
  }
  if (SOURCES_ENABLED.philpapers) {
    candidates = candidates.concat(safelyFetch('philpapers', fetchPhilPapers, errors));
  }
  if (SOURCES_ENABLED.openalex) {
    candidates = candidates.concat(safelyFetch('openalex', fetchOpenAlex, errors));
  }

  const newPapers = filterToNewPapers(candidates);
  const relevant = scoreAndTierPapers(filterToRelevantPapers(newPapers));

  Logger.log(
    'PREVIEW: %s candidates, %s new after dedupe, %s relevant (nothing written)',
    candidates.length, newPapers.length, relevant.length
  );
  relevant.forEach(function(paper, i) {
    Logger.log('%s. [%s, %s %s] %s  |  %s',
      i + 1, paper.source, paper.relevanceTier, paper.relevanceScore,
      paper.title, paper.matchedTopics.join(', '));
  });
  errors.forEach(function(message) {
    Logger.log('ERROR: %s', message);
  });
}
