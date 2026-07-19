/**
 * writeToSheet.gs
 *
 * Owns the Digest sheet's column schema and all writes to it.
 * dedupe.gs reads DIGEST_COLUMNS too (to know which columns hold the
 * identifier values) — if you ever reorder columns, this is the only
 * file you need to change; dedupe.gs will follow automatically.
 *
 * SHEET SETUP (one-time, manual): create a tab named per SHEET_TABS.digest
 * (see config.gs) with a header row matching DIGEST_HEADERS below, in the
 * same order. setupDigestSheet() (bottom of this file) will create/reset
 * the header row for you — run it once from the Apps Script editor before
 * the first real run.
 */

/**
 * Column numbers (1-indexed, matching Sheet API conventions) for every
 * field in the Digest sheet. Keep this in sync with DIGEST_HEADERS below —
 * the order here MUST match the order there.
 */
const DIGEST_COLUMNS = {
  dateAdded: 1,
  title: 2,
  authors: 3,
  abstractSnippet: 4,
  source: 5,
  publishedDate: 6,
  link: 7,
  matchedTopics: 8,
  doi: 9,
  arxivId: 10,
  philpapersId: 11,
  titleHash: 12,
};

const DIGEST_HEADERS = [
  'Date Added',
  'Title',
  'Authors',
  'Abstract Snippet',
  'Source',
  'Published Date',
  'Link',
  'Matched Topics',
  'DOI',
  'arXiv ID',
  'PhilPapers ID',
  'Title Hash',
];

/**
 * How long an abstract snippet can be in the Sheet before truncation.
 * Full abstracts can be very long; this keeps rows scannable. The full
 * abstract is still available by following the Link column.
 */
const ABSTRACT_SNIPPET_MAX_CHARS = 400;

/**
 * Gets the Digest sheet object, creating it if it doesn't exist yet.
 * @return {GoogeAppsScript.Spreadsheet.Sheet}
 */
function getDigestSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_TABS.digest);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_TABS.digest);
    writeDigestHeaders(sheet);
  }

  return sheet;
}

/**
 * Writes (or overwrites) the header row. Safe to call multiple times.
 * @param {GoogleAppsScript.Spreadsheet.Sheet=} sheet - Optional; looks up
 *        the Digest sheet itself if not provided.
 */
function writeDigestHeaders(sheet) {
  const targetSheet = sheet || getDigestSheet();
  targetSheet
    .getRange(1, 1, 1, DIGEST_HEADERS.length)
    .setValues([DIGEST_HEADERS]);
  targetSheet.setFrozenRows(1);
}

/**
 * Appends one row per paper to the Digest sheet. Expects papers that have
 * ALREADY passed dedupe.gs and relevanceFilter.gs — this function does not
 * check either; it just writes what it's given.
 *
 * @param {NormalizedPaper[]} papers - Each must have `matchedTopics`
 *        attached (see relevanceFilter.gs).
 */
function appendPapersToDigest(papers) {
  if (papers.length === 0) return;

  const sheet = getDigestSheet();
  const now = new Date();
  const dateAdded = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  const rows = papers.map(function(paper) {
    const row = new Array(DIGEST_HEADERS.length);

    row[DIGEST_COLUMNS.dateAdded - 1] = dateAdded;
    row[DIGEST_COLUMNS.title - 1] = paper.title;
    row[DIGEST_COLUMNS.authors - 1] = paper.authors;
    row[DIGEST_COLUMNS.abstractSnippet - 1] = truncateAbstract(paper.abstract);
    row[DIGEST_COLUMNS.source - 1] = paper.source;
    row[DIGEST_COLUMNS.publishedDate - 1] = paper.publishedDate;
    row[DIGEST_COLUMNS.link - 1] = paper.link;
    row[DIGEST_COLUMNS.matchedTopics - 1] = (paper.matchedTopics || []).join(', ');
    row[DIGEST_COLUMNS.doi - 1] = paper.doi || '';
    row[DIGEST_COLUMNS.arxivId - 1] = paper.arxivId || '';
    row[DIGEST_COLUMNS.philpapersId - 1] = paper.philpapersId || '';
    row[DIGEST_COLUMNS.titleHash - 1] = paper.titleHash;

    return row;
  });

  // Single batched write rather than one append per paper — much faster
  // and avoids hitting Apps Script's per-call quota on a big run.
  sheet
    .getRange(sheet.getLastRow() + 1, 1, rows.length, DIGEST_HEADERS.length)
    .setValues(rows);
}

/**
 * Truncates an abstract to ABSTRACT_SNIPPET_MAX_CHARS, breaking on a word
 * boundary where possible and appending an ellipsis if truncated.
 *
 * @param {string} abstract
 * @return {string}
 */
function truncateAbstract(abstract) {
  const text = abstract || '';
  if (text.length <= ABSTRACT_SNIPPET_MAX_CHARS) {
    return text;
  }

  const cut = text.slice(0, ABSTRACT_SNIPPET_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;

  return trimmed + '…';
}

/**
 * One-time setup helper. Run this manually from the Apps Script editor
 * (select setupDigestSheet from the function dropdown, click Run) before
 * the first real run, or any time you want to reset just the header row
 * without touching existing data rows.
 */
function setupDigestSheet() {
  const sheet = getDigestSheet();
  writeDigestHeaders(sheet);
  Logger.log('Digest sheet "%s" is ready with %s columns.', SHEET_TABS.digest, DIGEST_HEADERS.length);
}
