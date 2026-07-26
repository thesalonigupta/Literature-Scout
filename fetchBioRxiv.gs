/**
 * fetchBioRxiv.gs (OPTIONAL SOURCE — not wired into main.gs by default)
 *
 * Queries bioRxiv's public API for recent preprints in subject categories
 * relevant to your field. No API key required.
 *
 * WHEN TO ADD THIS: bioRxiv is a preprint server for biology broadly —
 * genetics, ecology, neuroscience, evolutionary biology, microbiology,
 * animal behavior, and more. Its full category list is at
 * https://api.biorxiv.org/covid19/help — look for "Subject Category" —
 * or just browse biorxiv.org's category filter in the UI. If your field
 * has zero life-science overlap, skip this one.
 *
 * NOTE ON EcoEvoRxiv: if you're building for an ecology/evolutionary-
 * biology-specific audience, EcoEvoRxiv (ecoevorxiv.org) would normally
 * be the more targeted choice over general bioRxiv. As of this writing
 * it's mid-migration to a new hosting platform with new submissions
 * suspended, so this file uses bioRxiv's "ecology" and
 * "animal_behavior_and_cognition" categories as a working substitute.
 * Worth revisiting once EcoEvoRxiv's migration settles — check whether
 * it has its own documented API before assuming bioRxiv is still the
 * best option.
 *
 * HOW TO WIRE THIS IN (this file alone isn't enough):
 *   1. Copy this file into your Apps Script project as `fetchBioRxiv`.
 *   2. In config.gs, add to SOURCES_ENABLED: `biorxiv: true,`
 *   3. In config.gs, add to SOURCE_SETTINGS:
 *        biorxiv: {
 *          categories: ['ecology', 'animal_behavior_and_cognition'], // CHANGE THIS to your field's categories
 *          maxPages: 5,
 *        },
 *   4. In main.gs, add to both runLiteratureScout() and
 *      testFetchAllSourcesWithoutWriting():
 *        if (SOURCES_ENABLED.biorxiv) {
 *          candidates = candidates.concat(safelyFetch('biorxiv', fetchBioRxiv, errors));
 *        }
 *      (and the Logger.log equivalent in the test function)
 *
 * NO KEYWORD SEARCH: like PhilPapers' OAI-PMH endpoint (see
 * fetchPhilPapers.gs's file header for the same situation), bioRxiv's API
 * only supports browsing by date range + category, not searching by
 * arbitrary text. So this file pulls everything in the lookback window
 * for the configured categories, applies a client-side pre-filter
 * (efficiency short-circuit, not a replacement for relevanceFilter.gs
 * downstream) to avoid normalizing hundreds of unrelated papers, then
 * lets the shared relevance filter do the real work — the exact same
 * two-pass approach fetchPhilPapers.gs already uses for its own
 * no-keyword-search endpoint.
 *
 * API docs: https://api.biorxiv.org/
 */

const BIORXIV_API_BASE = 'https://api.biorxiv.org/details/biorxiv';

/**
 * Fetches recent bioRxiv preprints across all configured categories.
 *
 * @return {NormalizedPaper[]}
 */
function fetchBioRxiv() {
  const settings = SOURCE_SETTINGS.biorxiv;
  const cutoff = getLookbackCutoffDate();
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const allPapers = [];

  settings.categories.forEach(function(category, index) {
    if (index > 0) {
      Utilities.sleep(250); // polite pacing, same convention as other sources
    }

    const records = fetchBioRxivCategoryRecords(category, cutoff, today, settings.maxPages);

    // Efficiency pre-filter before normalizing — see file header.
    const relevant = records.filter(recordMentionsAnyTopicBioRxiv);

    const papers = relevant
      .map(mapBioRxivRecordToNormalizedPaper)
      .filter(function(paper) { return paper !== null; });

    allPapers.push.apply(allPapers, papers);
  });

  return allPapers;
}

/**
 * Fetches all bioRxiv records for a single category within the date
 * window, paginating via cursor (100 records per page) up to maxPages as
 * a safety cap — same pagination-guard convention as
 * fetchPhilPapersOaiRecords() in fetchPhilPapers.gs.
 *
 * @param {string} category - e.g. 'ecology'
 * @param {string} startDate - ISO 'YYYY-MM-DD'
 * @param {string} endDate - ISO 'YYYY-MM-DD'
 * @param {number} maxPages
 * @return {Object[]} Raw bioRxiv "collection" entries.
 */
function fetchBioRxivCategoryRecords(category, startDate, endDate, maxPages) {
  const allRecords = [];
  let cursor = 0;
  let page = 0;

  do {
    const url = BIORXIV_API_BASE + '/' + startDate + '/' + endDate + '/' + cursor +
      '?category=' + encodeURIComponent(category);

    let response;
    try {
      response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    } catch (err) {
      Logger.log('fetchBioRxivCategoryRecords: request failed for category "%s": %s', category, err);
      break;
    }

    if (response.getResponseCode() !== 200) {
      Logger.log(
        'fetchBioRxivCategoryRecords: non-200 response (%s) for category "%s"',
        response.getResponseCode(),
        category
      );
      break;
    }

    let json;
    try {
      json = JSON.parse(response.getContentText());
    } catch (err) {
      Logger.log('fetchBioRxivCategoryRecords: failed to parse JSON for category "%s": %s', category, err);
      break;
    }

    const collection = json.collection || [];
    allRecords.push.apply(allRecords, collection);
    page++;

    // Stop once a page comes back under 100 (bioRxiv's page size) — no
    // more results remain — or once the safety cap is hit.
    if (collection.length < 100) break;
    cursor += 100;
  } while (page < maxPages);

  return allRecords;
}

/**
 * Checks whether a raw bioRxiv record's title or abstract mentions any
 * TOPICS term. Same short-circuit purpose as recordMentionsAnyTopic() in
 * fetchPhilPapers.gs — the shared relevanceFilter.gs still runs
 * downstream as the real filter; this just avoids normalizing records
 * about to be discarded. Named distinctly (with a BioRxiv suffix) so it
 * doesn't collide with fetchPhilPapers.gs's identically-purposed function
 * if both files are present in the same project.
 *
 * @param {Object} record - One entry from bioRxiv's `collection` array.
 * @return {boolean}
 */
function recordMentionsAnyTopicBioRxiv(record) {
  const haystack = ((record.title || '') + ' ' + (record.abstract || '')).toLowerCase();
  return TOPICS.some(function(topic) {
    return haystack.indexOf(topic.toLowerCase()) !== -1;
  });
}

/**
 * Maps a single bioRxiv record into a NormalizedPaper.
 *
 * @param {Object} record - One entry from bioRxiv's `collection` array.
 * @return {NormalizedPaper|null}
 */
function mapBioRxivRecordToNormalizedPaper(record) {
  const title = record.title || '';
  if (!title) return null;

  // bioRxiv's `authors` field is a single semicolon-separated
  // "Last, First; Last, First" string, not an array — reformat the
  // separator for consistency with how other sources join names, but
  // keep the "Last, First" ordering as-is rather than trying to invert it.
  const authors = (record.authors || '').split(';')
    .map(function(name) { return name.trim(); })
    .filter(function(name) { return name.length > 0; })
    .join(', ');

  const doi = record.doi || null;
  const link = doi ? 'https://doi.org/' + doi : '';

  try {
    return makeNormalizedPaper({
      title: title,
      authors: authors,
      abstract: record.abstract || '',
      link: link,
      source: 'biorxiv',
      publishedDate: record.date || '',
      doi: doi,
      arxivId: null,
      philpapersId: null,
    });
  } catch (err) {
    Logger.log('mapBioRxivRecordToNormalizedPaper: skipping record due to: %s', err);
    return null;
  }
}
