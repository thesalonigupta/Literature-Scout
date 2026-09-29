/**
 * dedupe.gs
 *
 * Decides whether a NormalizedPaper (see normalize.gs) has already been
 * logged, by checking FOUR identifiers, in order of trust:
 *
 *   1. DOI          (most trustworthy — globally unique, rarely wrong)
 *   2. arXiv ID      (trustworthy within arXiv, version-stripped)
 *   3. Title hash    (least trustworthy of the ID columns — exact-match
 *                      only, but it's the one identifier every paper has,
 *                      regardless of source, so it's the universal fallback)
 *   4. Abstract fingerprint (see below)
 *
 * Why not just one identifier: the same paper can surface from different
 * sources with different available IDs (e.g. first seen on arXiv with no
 * DOI yet, later seen via Crossref once published with a DOI). Checking
 * all of them means either appearance correctly recognizes the other.
 *
 * Design choice: this loads the full identifier columns into memory ONCE
 * per run (see loadExistingIdentifiers) rather than searching the Sheet
 * per-candidate. At realistic volumes (a few thousand rows after a couple
 * years of weekly runs) this is trivially fast and far simpler than a
 * TextFinder-per-row approach.
 *
 * ---------------------------------------------------------------------
 * THE ABSTRACT FINGERPRINT
 * ---------------------------------------------------------------------
 *
 * Some duplicates share NONE of the three IDs. Observed in practice: a
 * journal article that appeared twice via OpenAlex, once under its English
 * title with a DOI and once under its original-language title from the
 * journal's own site with no DOI. Different title, different link, no
 * shared ID, but a word-for-word identical English abstract. Versioned
 * repository deposits (figshare "v1" and "v4" of the same manuscript, with
 * different DOIs) behave the same way.
 *
 * The fingerprint is the first ABSTRACT_FINGERPRINT_LENGTH letters and
 * digits of the abstract, lowercased, with tags, HTML entities, spaces and
 * punctuation removed. Abstracts shorter than that get NO fingerprint, so
 * placeholder abstracts ("International audience", ".", "Abstract") can
 * never collide.
 *
 * Two things to know:
 *   - Only Latin letters and digits count, so an abstract written
 *     entirely in a non-Latin script gets no fingerprint. That's
 *     deliberate: it errs toward keeping a paper rather than dropping it.
 *   - Against papers already in the Sheet, the fingerprint is taken from
 *     the Digest's "Abstract Snippet" column. The Removed tab doesn't
 *     store abstracts, so a rejected paper can still come back if it
 *     reappears with different IDs.
 *
 * When two copies in the same run match ONLY on abstract, the copy with a
 * DOI is kept. Every abstract-only match is logged (View > Logs) with
 * both titles, since this is the fuzziest of the four checks and worth
 * being able to audit.
 *
 * ---------------------------------------------------------------------
 * THE REMOVED TAB — read this before changing how rejected papers are
 * handled.
 * ---------------------------------------------------------------------
 *
 * The Digest sheet was originally the ONLY record of what the Scout had
 * seen. That created a quiet failure: deleting a row from Digest also
 * deleted its DOI, arXiv ID and title hash, which are the only things
 * telling the Scout it had seen that paper. A deleted paper was therefore
 * a paper the Scout had never heard of, and it came back the next time a
 * source re-surfaced it.
 *
 * This is not hypothetical: it shows up as soon as you do a bulk manual
 * review. Rows deleted by hand come back on a later run, with their
 * original title hashes intact, as soon as any source re-surfaces them.
 *
 * The fix: a second tab, named per SHEET_TABS.removed, holding the same
 * three identifiers for papers a researcher has rejected.
 * loadExistingIdentifiers() reads BOTH tabs, so a rejected paper stays
 * rejected without living in the Digest.
 *
 * WHAT THIS CHANGES ABOUT YOUR WORKFLOW: don't delete rows from Digest.
 * Select them and use "Literature Scout > Move selected rows to Removed"
 * in the Sheet's menu bar, which copies the identifiers across and then
 * deletes the rows for you. Deleting by hand still works, it just loses
 * the fingerprint and the paper can come back.
 *
 * The Removed tab keeps the title and link alongside the identifiers.
 * Strictly the three IDs would do, but a bare list of hashes is
 * unauditable — if someone later asks "why isn't the Scout finding X?",
 * you want to be able to answer that from the sheet rather than by
 * guessing.
 */

/**
 * How many letters/digits of an abstract make up its fingerprint.
 * Abstracts with fewer than this many get no fingerprint at all.
 *
 * 200 is long enough that two DIFFERENT papers sharing it is very
 * unlikely, and short enough to fit inside the Digest's abstract snippet
 * (which is what previously-logged papers are compared against).
 */
const ABSTRACT_FINGERPRINT_LENGTH = 200;

/**
 * Name of the Digest column holding the abstract snippet. Looked up by
 * header text rather than column number so reordering columns can't
 * silently point this at the wrong data.
 */
const ABSTRACT_SNIPPET_HEADER = 'Abstract Snippet';

/**
 * Name of the Removed tab. Read from SHEET_TABS.removed if present, so
 * it can be renamed alongside the other tabs in config.gs; falls back to
 * 'Removed' so this file works whether or not config.gs has been updated.
 *
 * @return {string}
 */
function getRemovedTabName() {
  if (typeof SHEET_TABS === 'object' && SHEET_TABS && SHEET_TABS.removed) {
    return SHEET_TABS.removed;
  }
  return 'Removed';
}

/**
 * Column numbers (1-indexed) for the Removed tab. The three identifier
 * columns are what dedupe actually reads; the rest is there so a human
 * can tell what a row refers to.
 */
const REMOVED_COLUMNS = {
  removedOn: 1,
  title: 2,
  source: 3,
  link: 4,
  doi: 5,
  arxivId: 6,
  titleHash: 7,
  note: 8,
};

const REMOVED_HEADERS = [
  'Removed On',
  'Title',
  'Source',
  'Link',
  'DOI',
  'arXiv ID',
  'Title Hash',
  'Note',
];

/**
 * Gets the Removed sheet, creating it with headers if it doesn't exist.
 *
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getRemovedSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = getRemovedTabName();
  let sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, REMOVED_HEADERS.length).setValues([REMOVED_HEADERS]);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

/**
 * One-time setup helper. Run this once from the Apps Script editor to
 * create the Removed tab before the first run that uses it.
 *
 * Safe to run again later — it only rewrites the header row and never
 * touches existing data.
 */
function setupRemovedSheet() {
  const sheet = getRemovedSheet();
  sheet.getRange(1, 1, 1, REMOVED_HEADERS.length).setValues([REMOVED_HEADERS]);
  sheet.setFrozenRows(1);
  Logger.log(
    'Removed sheet "%s" is ready. Rows here are permanently excluded from ' +
    'future runs.', getRemovedTabName()
  );
}

/**
 * Builds the abstract fingerprint described in the file header.
 *
 * @param {string} text - An abstract, or an abstract snippet from the Sheet.
 * @return {string} The fingerprint, or '' if the abstract is too short
 *         (or too non-Latin) to fingerprint safely.
 */
function abstractFingerprint(text) {
  const normalized = String(text || '')
    .replace(/&[#a-z0-9]+;/gi, ' ')   // HTML entities, e.g. &lt;p&gt;
    .replace(/<[^>]*>/g, ' ')         // any real tags left over
    .toLowerCase()
    .replace(/^\s*abstract\b/, '')    // some sources prefix "Abstract", some don't
    .replace(/[^a-z0-9]/g, '');

  if (normalized.length < ABSTRACT_FINGERPRINT_LENGTH) return '';
  return normalized.slice(0, ABSTRACT_FINGERPRINT_LENGTH);
}

/**
 * Loads every known identifier into Sets for fast lookup — from the
 * Digest tab (papers already logged) AND the Removed tab (papers a
 * researcher has rejected). Call this ONCE at the start of a run, then
 * pass the result to isDuplicate() for every candidate paper.
 *
 * @return {{dois: Set<string>, arxivIds: Set<string>, titleHashes: Set<string>,
 *          abstractPrints: Set<string>}}
 */
function loadExistingIdentifiers() {
  const existing = {
    dois: new Set(),
    arxivIds: new Set(),
    titleHashes: new Set(),
    abstractPrints: new Set(),
  };

  const digest = getDigestSheet();

  addIdentifiersFromSheet(
    existing,
    digest,
    DIGEST_COLUMNS.doi,
    DIGEST_COLUMNS.arxivId,
    DIGEST_COLUMNS.titleHash
  );

  addAbstractPrintsFromDigest(existing, digest);

  addIdentifiersFromRemovedSheet(existing);

  return existing;
}

/**
 * Adds a fingerprint for every Digest row's abstract snippet.
 *
 * Tolerant like the Removed loader: if the column can't be found, it logs
 * and carries on with the other three checks rather than failing the run.
 *
 * @param {{abstractPrints: Set}} existing - Mutated in place.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} digest
 */
function addAbstractPrintsFromDigest(existing, digest) {
  const column = DIGEST_HEADERS.indexOf(ABSTRACT_SNIPPET_HEADER) + 1;

  if (column === 0) {
    Logger.log(
      'loadExistingIdentifiers: no "%s" column in DIGEST_HEADERS, so abstract ' +
      'matching only runs within a single batch this run.',
      ABSTRACT_SNIPPET_HEADER
    );
    return;
  }

  const lastRow = digest.getLastRow();
  if (lastRow < 2) return;

  const snippets = digest.getRange(2, column, lastRow - 1, 1).getValues();

  snippets.forEach(function(row) {
    const print = abstractFingerprint(row[0]);
    if (print) existing.abstractPrints.add(print);
  });
}

/**
 * Adds the Removed tab's identifiers to an identifier set.
 *
 * Deliberately tolerant: if the tab doesn't exist yet, or is empty, this
 * logs and moves on rather than throwing. A missing Removed tab should
 * degrade to the old behaviour (rejected papers can return), not break
 * the whole run.
 *
 * @param {{dois: Set, arxivIds: Set, titleHashes: Set}} existing - Mutated in place.
 */
function addIdentifiersFromRemovedSheet(existing) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(getRemovedTabName());

  if (!sheet) {
    Logger.log(
      'loadExistingIdentifiers: no "%s" tab found, so previously-rejected ' +
      'papers can reappear. Run setupRemovedSheet() once to create it.',
      getRemovedTabName()
    );
    return;
  }

  const countBefore = existing.titleHashes.size;

  addIdentifiersFromSheet(
    existing,
    sheet,
    REMOVED_COLUMNS.doi,
    REMOVED_COLUMNS.arxivId,
    REMOVED_COLUMNS.titleHash
  );

  Logger.log(
    'loadExistingIdentifiers: loaded %s rejected papers from "%s".',
    existing.titleHashes.size - countBefore,
    getRemovedTabName()
  );
}

/**
 * Reads three identifier columns out of a sheet and adds every non-empty
 * value to the matching Set. Shared by the Digest and Removed loaders so
 * both tabs are read exactly the same way.
 *
 * @param {{dois: Set, arxivIds: Set, titleHashes: Set}} existing - Mutated in place.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} doiColumn - 1-indexed.
 * @param {number} arxivColumn - 1-indexed.
 * @param {number} titleHashColumn - 1-indexed.
 */
function addIdentifiersFromSheet(existing, sheet, doiColumn, arxivColumn, titleHashColumn) {
  const lastRow = sheet.getLastRow();

  // Header-only or empty sheet — nothing to load.
  if (lastRow < 2) return;

  const numRows = lastRow - 1; // exclude header row

  const dois = sheet.getRange(2, doiColumn, numRows, 1).getValues();
  const arxivIds = sheet.getRange(2, arxivColumn, numRows, 1).getValues();
  const titleHashes = sheet.getRange(2, titleHashColumn, numRows, 1).getValues();

  for (let i = 0; i < numRows; i++) {
    const doi = String(dois[i][0] || '').trim();
    const arxivId = String(arxivIds[i][0] || '').trim();
    const titleHash = String(titleHashes[i][0] || '').trim();

    if (doi) existing.dois.add(doi);
    if (arxivId) existing.arxivIds.add(arxivId);
    if (titleHash) existing.titleHashes.add(titleHash);
  }
}

/**
 * Checks whether a NormalizedPaper matches anything already logged or
 * previously rejected.
 *
 * @param {NormalizedPaper} paper
 * @param {{dois: Set, arxivIds: Set, titleHashes: Set, abstractPrints: Set}} existing -
 *        From loadExistingIdentifiers(), or the within-batch equivalent.
 * @return {{isDupe: boolean, matchedOn: string|null}}
 */
function isDuplicate(paper, existing) {
  if (paper.doi && existing.dois.has(paper.doi)) {
    return { isDupe: true, matchedOn: 'doi' };
  }

  if (paper.arxivId && existing.arxivIds.has(paper.arxivId)) {
    return { isDupe: true, matchedOn: 'arxivId' };
  }

  if (paper.titleHash && existing.titleHashes.has(paper.titleHash)) {
    return { isDupe: true, matchedOn: 'titleHash' };
  }

  if (existing.abstractPrints) {
    const print = abstractFingerprint(paper.abstract);
    if (print && existing.abstractPrints.has(print)) {
      return { isDupe: true, matchedOn: 'abstract' };
    }
  }

  return { isDupe: false, matchedOn: null };
}

/**
 * Records a kept paper's identifiers so later candidates in the same
 * batch can be checked against it.
 *
 * @param {NormalizedPaper} paper
 * @param {string} print - Its abstract fingerprint ('' if none).
 * @param {{dois: Set, arxivIds: Set, titleHashes: Set, abstractPrints: Set}} seen
 */
function recordInBatch(paper, print, seen) {
  if (paper.doi) seen.dois.add(paper.doi);
  if (paper.arxivId) seen.arxivIds.add(paper.arxivId);
  if (paper.titleHash) seen.titleHashes.add(paper.titleHash);
  if (print) seen.abstractPrints.add(print);
}

/**
 * Filters a list of NormalizedPapers down to only the genuinely new ones,
 * AND prevents duplicates WITHIN the same batch (e.g. the same paper
 * showing up from both arXiv and Crossref in a single run, before either
 * has been written to the Sheet yet).
 *
 * This is the function main.gs should actually call — it handles "already
 * in the Sheet", "already rejected", and "already seen earlier in this
 * same run".
 *
 * @param {NormalizedPaper[]} candidates - Combined results from all
 *        enabled sources for this run.
 * @return {NormalizedPaper[]} Only the papers that are new on every count.
 */
function filterToNewPapers(candidates) {
  const existing = loadExistingIdentifiers();
  const seenInThisBatch = {
    dois: new Set(),
    arxivIds: new Set(),
    titleHashes: new Set(),
    abstractPrints: new Set(),
  };

  // fingerprint -> index in newPapers, so an abstract-only match can swap
  // in a better copy of a paper already kept.
  const keptIndexByPrint = {};

  const newPapers = [];

  candidates.forEach(function(paper) {
    const dupeCheck = isDuplicate(paper, existing);
    if (dupeCheck.isDupe) {
      if (dupeCheck.matchedOn === 'abstract') {
        Logger.log(
          'filterToNewPapers: skipped "%s" — same abstract as a paper already in the Sheet.',
          paper.title
        );
      }
      return; // already logged in a previous run, or previously rejected — skip
    }

    const print = abstractFingerprint(paper.abstract);

    const withinBatchDupe = isDuplicate(paper, seenInThisBatch);
    if (withinBatchDupe.isDupe) {
      // Abstract-only match: usually a translation or a second repository
      // copy. Prefer whichever copy has a DOI.
      if (withinBatchDupe.matchedOn === 'abstract') {
        const index = keptIndexByPrint[print];
        const kept = index !== undefined ? newPapers[index] : null;

        if (kept && paper.doi && !kept.doi) {
          Logger.log(
            'filterToNewPapers: "%s" replaces "%s" — same abstract, and this copy has a DOI.',
            paper.title, kept.title
          );
          newPapers[index] = paper;
          recordInBatch(paper, print, seenInThisBatch);
        } else {
          Logger.log(
            'filterToNewPapers: skipped "%s" — same abstract as "%s" earlier in this run.',
            paper.title, kept ? kept.title : '(unknown)'
          );
        }
      }
      return; // same paper already pulled from a different source THIS run — skip
    }

    // Genuinely new — record it so later candidates in this same batch
    // can be checked against it, then keep it.
    recordInBatch(paper, print, seenInThisBatch);
    if (print) keptIndexByPrint[print] = newPapers.length;

    newPapers.push(paper);
  });

  return newPapers;
}

// ---------------------------------------------------------------------------
// Moving rows out of the Digest
// ---------------------------------------------------------------------------

/**
 * Moves the currently-selected Digest rows to the Removed tab: copies
 * their identifiers across, then deletes them from Digest.
 *
 * Normally invoked from the Sheet's "Literature Scout" menu rather than
 * called directly. Select any cell in each row you want gone (Ctrl/Cmd
 * click for several, or drag to select a block), then run it.
 *
 * Notes on the implementation, since both are easy to get wrong:
 *   - Rows are deleted from the BOTTOM UP. Deleting top-down shifts every
 *     row beneath the one you just removed, so the second deletion would
 *     hit the wrong row.
 *   - Multiple non-contiguous selections are handled via
 *     getActiveRangeList(), not getActiveRange(), which only returns the
 *     last block selected.
 */
function moveSelectedRowsToRemoved() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const digest = ss.getSheetByName(SHEET_TABS.digest);
  const active = ss.getActiveSheet();

  if (!digest || active.getName() !== digest.getName()) {
    ui.alert(
      'Select rows on the "' + SHEET_TABS.digest + '" tab first, then run ' +
      'this again.'
    );
    return;
  }

  const rowNumbers = getSelectedDataRowNumbers(digest);

  if (rowNumbers.length === 0) {
    ui.alert('No data rows are selected. Click a cell in each row you want to remove.');
    return;
  }

  const response = ui.alert(
    'Move ' + rowNumbers.length + ' row' + (rowNumbers.length === 1 ? '' : 's') +
    ' to "' + getRemovedTabName() + '"?',
    'They will be deleted from ' + SHEET_TABS.digest + ' and will not be ' +
    'picked up again by future runs.',
    ui.ButtonSet.OK_CANCEL
  );

  if (response !== ui.Button.OK) return;

  const removed = getRemovedSheet();
  const removedOn = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const numCols = DIGEST_HEADERS.length;

  // Read every row's values BEFORE deleting anything, so the deletions
  // below can't invalidate the row numbers we're reading from.
  const rowsToAppend = rowNumbers.map(function(rowNumber) {
    const values = digest.getRange(rowNumber, 1, 1, numCols).getValues()[0];
    const out = new Array(REMOVED_HEADERS.length).fill('');

    out[REMOVED_COLUMNS.removedOn - 1] = removedOn;
    out[REMOVED_COLUMNS.title - 1] = values[DIGEST_COLUMNS.title - 1];
    out[REMOVED_COLUMNS.source - 1] = values[DIGEST_COLUMNS.source - 1];
    out[REMOVED_COLUMNS.link - 1] = values[DIGEST_COLUMNS.link - 1];
    out[REMOVED_COLUMNS.doi - 1] = values[DIGEST_COLUMNS.doi - 1];
    out[REMOVED_COLUMNS.arxivId - 1] = values[DIGEST_COLUMNS.arxivId - 1];
    out[REMOVED_COLUMNS.titleHash - 1] = values[DIGEST_COLUMNS.titleHash - 1];
    out[REMOVED_COLUMNS.note - 1] = '';

    return out;
  });

  removed
    .getRange(removed.getLastRow() + 1, 1, rowsToAppend.length, REMOVED_HEADERS.length)
    .setValues(rowsToAppend);

  // Bottom-up, so earlier deletions don't shift the rows still to come.
  rowNumbers
    .slice()
    .sort(function(a, b) { return b - a; })
    .forEach(function(rowNumber) {
      digest.deleteRow(rowNumber);
    });

  ss.toast(
    rowNumbers.length + ' row' + (rowNumbers.length === 1 ? '' : 's') +
    ' moved to ' + getRemovedTabName() + '.',
    'Literature Scout',
    5
  );
}

/**
 * Returns the row numbers of every selected data row, deduplicated,
 * sorted ascending, with the header row excluded.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {number[]} 1-indexed row numbers.
 */
function getSelectedDataRowNumbers(sheet) {
  const rangeList = sheet.getActiveRangeList();
  if (!rangeList) return [];

  const rowNumbers = [];

  rangeList.getRanges().forEach(function(range) {
    const start = range.getRow();
    const end = start + range.getNumRows() - 1;

    for (let row = start; row <= end; row++) {
      if (row < 2) continue; // header
      if (row > sheet.getLastRow()) continue;
      if (rowNumbers.indexOf(row) === -1) rowNumbers.push(row);
    }
  });

  return rowNumbers.sort(function(a, b) { return a - b; });
}

/**
 * Adds a "Literature Scout" menu to the Sheet. Apps Script calls this
 * automatically whenever someone opens the spreadsheet.
 *
 * It lives in this file because the only menu item is the Removed-tab
 * workflow. If more menu items are added later, move this to main.gs —
 * Apps Script allows only ONE onOpen across the whole project, so a
 * second definition anywhere would silently override this one.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Literature Scout')
    .addItem('Move selected rows to Removed', 'moveSelectedRowsToRemoved')
    .addToUi();
}
