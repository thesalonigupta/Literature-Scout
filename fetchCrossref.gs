/**
 * fetchCrossref.gs
 *
 * Queries Crossref's REST API (no key required, just a polite contact
 * email) for recently-indexed works matching your topics. This is the
 * Scout's main catch-all for traditionally-published journal articles —
 * including Oxford Academic, Wiley, Springer, and other publishers that
 * don't offer their own search API but DO deposit metadata with Crossref.
 *
 * API docs: https://api.crossref.org/swagger-ui/index.html
 * "Polite pool": including a mailto param gets faster, more reliable
 * responses — see SOURCE_SETTINGS.crossref.politeEmail in config.gs.
 *
 * Design choice: rather than one big OR query (Crossref's query syntax
 * doesn't cleanly support that), this queries once PER entry in
 * FETCH_QUERIES (config.gs) and merges results. dedupe.gs's within-batch
 * check handles the overlap when one paper comes back for several queries.
 * The queries are a short list kept separate from the relevance terms, so
 * the number of requests per run stays small even as the relevance rules
 * grow.
 */

const CROSSREF_API_BASE = 'https://api.crossref.org/works';

/**
 * Fetches recent Crossref works for every query in FETCH_QUERIES.
 *
 * @return {NormalizedPaper[]}
 */
function fetchCrossref() {
  const settings = SOURCE_SETTINGS.crossref;
  const cutoff = getLookbackCutoffDate();
  const allPapers = [];

  FETCH_QUERIES.forEach(function(topic, index) {
    // Same precaution as fetchOpenAlex.gs: this hasn't been observed to
    // rate-limit Crossref in testing, but the request pattern (many
    // rapid calls in a tight loop) is identical to what DID trigger 429s
    // on OpenAlex — cheap insurance against the same failure mode here.
    if (index > 0) {
      Utilities.sleep(150);
    }

    const papers = fetchCrossrefForTopic(topic, cutoff, settings);
    allPapers.push.apply(allPapers, papers);
  });

  return allPapers;
}

/**
 * Fetches recent Crossref works matching a single topic phrase.
 *
 * @param {string} topic
 * @param {string} cutoffDate - ISO 'YYYY-MM-DD'
 * @param {Object} settings - SOURCE_SETTINGS.crossref
 * @return {NormalizedPaper[]}
 */
function fetchCrossrefForTopic(topic, cutoffDate, settings) {
  const params = [
    'query.bibliographic=' + encodeURIComponent(topic),
    // Upper bound: see getPublicationDateCeiling() in config.gs. Without
    // it, sort=published fills the result window with bogus future-dated
    // records.
    // Type filters: SOURCE_SETTINGS.crossref.includeTypes (config.gs).
    // Crossref treats repeated filters of the same name as OR, so
    // "type:journal-article,type:book-chapter" means either type.
    'filter=from-pub-date:' + cutoffDate +
      ',until-pub-date:' + getPublicationDateCeiling() +
      (settings.includeTypes || []).map(function(type) {
        return ',type:' + type;
      }).join(''),
    'rows=' + settings.rowsPerQuery,
    'sort=published',
    'order=desc',
    'mailto=' + encodeURIComponent(settings.politeEmail),
  ];

  const url = CROSSREF_API_BASE + '?' + params.join('&');

  let response;
  try {
    response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) {
    Logger.log('fetchCrossrefForTopic: request failed for topic "%s": %s', topic, err);
    return [];
  }

  if (response.getResponseCode() !== 200) {
    Logger.log(
      'fetchCrossrefForTopic: non-200 response (%s) for topic "%s"',
      response.getResponseCode(),
      topic
    );
    return [];
  }

  let json;
  try {
    json = JSON.parse(response.getContentText());
  } catch (err) {
    Logger.log('fetchCrossrefForTopic: failed to parse JSON for topic "%s": %s', topic, err);
    return [];
  }

  const items = (json.message && json.message.items) || [];

  return items
    .map(mapCrossrefItemToNormalizedPaper)
    .filter(function(paper) {
      return paper !== null;
    });
}

/**
 * Maps a single Crossref "work" item into a NormalizedPaper.
 * Returns null if the item is missing a title (can't usefully dedupe or
 * display a titleless entry) rather than throwing and killing the whole
 * batch over one malformed record.
 *
 * @param {Object} item - One element of message.items from Crossref's
 *        response JSON.
 * @return {NormalizedPaper|null}
 */
function mapCrossrefItemToNormalizedPaper(item) {
  const titleArr = item.title || [];
  const title = titleArr.length > 0 ? titleArr[0] : '';

  if (!title) return null;

  // Crossref placeholder records ("Title Pending 9860") registered ahead
  // of publication, with no real metadata. They can arrive in bulk.
  if (/^title pending\b/i.test(title)) return null;

  const authors = (item.author || [])
    .map(function(a) {
      const given = a.given || '';
      const family = a.family || '';
      return (given + ' ' + family).trim();
    })
    .filter(function(name) { return name.length > 0; })
    .join(', ');

  // Crossref rarely includes an abstract; when present it's sometimes
  // wrapped in JATS XML tags (<jats:p>...</jats:p>) — strip basic tags.
  const abstract = stripXmlTags(item.abstract || '');

  const link = item.URL || (item.DOI ? 'https://doi.org/' + item.DOI : '');

  const publishedDate = extractCrossrefDate(item);

  try {
    return makeNormalizedPaper({
      title: title,
      authors: authors,
      abstract: abstract,
      link: link,
      source: 'crossref',
      publishedDate: publishedDate,
      doi: item.DOI || null,
      arxivId: null,
      philpapersId: null,
    });
  } catch (err) {
    Logger.log('mapCrossrefItemToNormalizedPaper: skipping item due to: %s', err);
    return null;
  }
}

/**
 * Crossref dates come as a nested {date-parts: [[year, month, day]]}
 * structure, and a work can have several date fields (published,
 * published-online, published-print). Prefers published-online if
 * present (usually the earliest), falling back to published.
 *
 * @param {Object} item
 * @return {string} ISO 'YYYY-MM-DD', or '' if no usable date found.
 */
function extractCrossrefDate(item) {
  const dateField = item['published-online'] || item['published-print'] || item['published'];
  if (!dateField || !dateField['date-parts'] || !dateField['date-parts'][0]) {
    return '';
  }

  const parts = dateField['date-parts'][0];
  const year = parts[0];
  const month = parts[1] || 1;
  const day = parts[2] || 1;

  if (!year) return '';

  const pad = function(n) { return String(n).padStart(2, '0'); };
  return year + '-' + pad(month) + '-' + pad(day);
}

/**
 * Strips simple XML/HTML tags from a string. Crossref abstracts are
 * sometimes JATS-XML-wrapped; this is a basic strip, not a full parser —
 * fine for display purposes since we only need plain text for the Sheet.
 *
 * @param {string} text
 * @return {string}
 */
function stripXmlTags(text) {
  return String(text || '').replace(/<[^>]*>/g, '').trim();
}
