/**
 * dedupe.gs
 *
 * Decides whether a NormalizedPaper (see normalize.gs) has already been
 * logged, by checking THREE identifier columns in the Digest sheet, in
 * order of trust:
 *
 *   1. DOI          (most trustworthy — globally unique, rarely wrong)
 *   2. arXiv ID      (trustworthy within arXiv, version-stripped)
 *   3. Title hash    (least trustworthy — exact-match only, but it's the
 *                      one identifier every paper has, regardless of
 *                      source, so it's the universal fallback)
 *
 * Why not just one identifier: the same paper can surface from different
 * sources with different available IDs (e.g. first seen on arXiv with no
 * DOI yet, later seen via Crossref once published with a DOI). Checking
 * all three means either appearance correctly recognizes the other.
 *
 * Design choice: this loads the full identifier columns into memory ONCE
 * per run (see loadExistingIdentifiers) rather than searching the Sheet
 * per-candidate. At realistic volumes (a few thousand rows after a couple
 * years of weekly runs) this is trivially fast and far simpler than a
 * TextFinder-per-row approach.
 */

/**
 * Loads every existing identifier from the Digest sheet into Sets for
 * fast lookup. Call this ONCE at the start of a run, then pass the result
 * to isDuplicate() for every candidate paper.
 *
 * @return {{dois: Set<string>, arxivIds: Set<string>, titleHashes: Set<string>}}
 */
function loadExistingIdentifiers() {
  const sheet = getDigestSheet();
  const lastRow = sheet.getLastRow();

  const existing = {
    dois: new Set(),
    arxivIds: new Set(),
    titleHashes: new Set(),
  };

  // Header-only or empty sheet — nothing to load.
  if (lastRow < 2) {
    return existing;
  }

  const columns = DIGEST_COLUMNS; // defined in writeToSheet.gs
  const numRows = lastRow - 1; // exclude header row

  const dois = sheet
    .getRange(2, columns.doi, numRows, 1)
    .getValues();
  const arxivIds = sheet
    .getRange(2, columns.arxivId, numRows, 1)
    .getValues();
  const titleHashes = sheet
    .getRange(2, columns.titleHash, numRows, 1)
    .getValues();

  for (let i = 0; i < numRows; i++) {
    const doi = String(dois[i][0] || '').trim();
    const arxivId = String(arxivIds[i][0] || '').trim();
    const titleHash = String(titleHashes[i][0] || '').trim();

    if (doi) existing.dois.add(doi);
    if (arxivId) existing.arxivIds.add(arxivId);
    if (titleHash) existing.titleHashes.add(titleHash);
  }

  return existing;
}

/**
 * Checks whether a NormalizedPaper matches anything already logged.
 *
 * @param {NormalizedPaper} paper
 * @param {{dois: Set, arxivIds: Set, titleHashes: Set}} existing - From
 *        loadExistingIdentifiers().
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

  return { isDupe: false, matchedOn: null };
}

/**
 * Filters a list of NormalizedPapers down to only the genuinely new ones,
 * AND prevents duplicates WITHIN the same batch (e.g. the same paper
 * showing up from both arXiv and Crossref in a single run, before either
 * has been written to the Sheet yet).
 *
 * This is the function main.gs should actually call — it handles both
 * "already in the Sheet" and "already seen earlier in this same run".
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
  };

  const newPapers = [];

  candidates.forEach(function(paper) {
    const dupeCheck = isDuplicate(paper, existing);
    if (dupeCheck.isDupe) {
      return; // already logged in a previous run — skip
    }

    const withinBatchDupe = isDuplicate(paper, seenInThisBatch);
    if (withinBatchDupe.isDupe) {
      return; // same paper already pulled from a different source THIS run — skip
    }

    // Genuinely new — record it so later candidates in this same batch
    // can be checked against it, then keep it.
    if (paper.doi) seenInThisBatch.dois.add(paper.doi);
    if (paper.arxivId) seenInThisBatch.arxivIds.add(paper.arxivId);
    if (paper.titleHash) seenInThisBatch.titleHashes.add(paper.titleHash);

    newPapers.push(paper);
  });

  return newPapers;
}
