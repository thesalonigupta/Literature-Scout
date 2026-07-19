/**
 * fetchOpenAlex.gs
 *
 * Queries OpenAlex's REST API for recent works matching your topics.
 *
 * IMPORTANT — OpenAlex changed its access model in Feb 2026: the old
 * mailto=you@example.com "polite pool" system is DEPRECATED and no
 * longer affects rate limits at all. Every request now requires an
 * api_key param. Without one you get a one-time $0.10/day budget (easily
 * exhausted by a single run across your full topic list); WITH a free key
 * you get $1.00/day, which comfortably covers this pipeline's usage.
 * Getting a key is free — sign up at openalex.org, copy it from
 * openalex.org/settings/api. See PropertiesService setup note below.
 *
 * Role in this pipeline: SECONDARY / redundant check, not a primary
 * source. OpenAlex draws heavily from Crossref under the hood, so most of
 * what it finds will already have been caught by fetchCrossref.gs and
 * filtered out by dedupe.gs's within-batch check. It's included mainly to
 * catch the cases where OpenAlex has indexed something Crossref's API
 * response didn't surface cleanly (e.g. abstract present in one but not
 * the other), and as a cross-check while the Scout is new and being
 * trusted. SOURCES_ENABLED.openalex in config.gs can be set to false
 * later if it's not pulling its weight relative to the extra API calls.
 *
 * SETUP REQUIRED before this file will work: the API key must be stored
 * in Script Properties (NOT hardcoded here). In the Apps Script editor:
 * Project Settings (gear icon) > Script Properties > Add script property
 * > name it OPENALEX_API_KEY, paste your key as the value.
 * getOpenAlexApiKey() below reads it from there.
 *
 * API docs: https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication
 */

const OPENALEX_API_BASE = 'https://api.openalex.org/works';

/**
 * Reads the OpenAlex API key from Script Properties. Throws a clear error
 * (rather than silently sending requests with no key, which would fail
 * with a confusing budget-exhausted error) if it hasn't been set up yet.
 *
 * @return {string}
 */
function getOpenAlexApiKey() {
  const key = PropertiesService.getScriptProperties().getProperty('OPENALEX_API_KEY');
  if (!key) {
    throw new Error(
      'OPENALEX_API_KEY is not set in Script Properties. ' +
      'Go to Project Settings > Script Properties and add it ' +
      '(see fetchOpenAlex.gs file header for details). ' +
      'Get a free key at openalex.org/settings/api.'
    );
  }
  return key;
}


/**
 * Fetches recent OpenAlex works across all TOPICS.
 *
 * @return {NormalizedPaper[]}
 */
function fetchOpenAlex() {
  const settings = SOURCE_SETTINGS.openalex;
  const cutoff = getLookbackCutoffDate();
  const allPapers = [];

  TOPICS.forEach(function(topic, index) {
    // OpenAlex rate-limits aggressively when many requests arrive in
    // quick succession (seen in practice: 429 "Too Many Requests" across
    // most of a topic loop with no delay). A short pause between
    // requests keeps us under that threshold. Skipped on the very first
    // request since there's nothing to wait after yet.
    if (index > 0) {
      Utilities.sleep(250);
    }

    const papers = fetchOpenAlexForTopic(topic, cutoff, settings);
    allPapers.push.apply(allPapers, papers);
  });

  return allPapers;
}

/**
 * Fetches recent OpenAlex works matching a single topic phrase.
 *
 * @param {string} topic
 * @param {string} cutoffDate - ISO 'YYYY-MM-DD'
 * @param {Object} settings - SOURCE_SETTINGS.openalex
 * @return {NormalizedPaper[]}
 */
function fetchOpenAlexForTopic(topic, cutoffDate, settings) {
  // IMPORTANT: the filter VALUE syntax (attribute:value, comma-joined for
  // AND) must NOT be percent-encoded as a whole — OpenAlex's documented
  // examples consistently show filter=from_publication_date:2001-03-14
  // with the colon and comma sent literally. Only the actual VALUES that
  // might contain special characters get encoded individually; the
  // filter syntax itself stays literal.
  const filterString = 'from_publication_date:' + encodeURIComponent(cutoffDate);

  const params = [
    'search=' + encodeURIComponent(topic),
    'filter=' + filterString,
    'per-page=' + settings.maxResults,
    'sort=publication_date:desc',
    'api_key=' + encodeURIComponent(getOpenAlexApiKey()),
  ];

  const url = OPENALEX_API_BASE + '?' + params.join('&');

  let response;
  try {
    response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) {
    Logger.log('fetchOpenAlexForTopic: request failed for topic "%s": %s', topic, err);
    return [];
  }

  if (response.getResponseCode() !== 200) {
    // Log enough to actually diagnose a failure instead of guessing:
    // response body often contains OpenAlex's specific error message
    // (e.g. budget exhaustion vs an invalid filter vs a bad key), which
    // is the difference between "wait until midnight UTC" and "fix the
    // code" — don't redact the URL here, but DO avoid logging the key
    // itself in plaintext repeatedly across a topic loop.
    Logger.log(
      'fetchOpenAlexForTopic: non-200 response (%s) for topic "%s"',
      response.getResponseCode(),
      topic
    );
    Logger.log('  Response body (first 300 chars): %s', response.getContentText().slice(0, 300));
    return [];
  }

  let json;
  try {
    json = JSON.parse(response.getContentText());
  } catch (err) {
    Logger.log('fetchOpenAlexForTopic: failed to parse JSON for topic "%s": %s', topic, err);
    return [];
  }

  const results = json.results || [];

  return results
    .map(mapOpenAlexWorkToNormalizedPaper)
    .filter(function(paper) { return paper !== null; });
}

/**
 * Maps a single OpenAlex "work" object into a NormalizedPaper.
 *
 * @param {Object} work - One element of the `results` array from
 *        OpenAlex's response JSON.
 * @return {NormalizedPaper|null}
 */
function mapOpenAlexWorkToNormalizedPaper(work) {
  const title = work.title || work.display_name || '';
  if (!title) return null;

  const authors = (work.authorships || [])
    .map(function(authorship) {
      return authorship.author ? authorship.author.display_name : '';
    })
    .filter(function(name) { return name.length > 0; })
    .join(', ');

  // OpenAlex stores abstracts as an "inverted index" (word -> positions)
  // rather than plain text, for copyright reasons. Reconstruct plain text.
  const abstract = reconstructAbstractFromInvertedIndex(work.abstract_inverted_index);

  const doi = work.doi ? normalizeDoi(work.doi) : null;

  const link = work.primary_location && work.primary_location.landing_page_url
    ? work.primary_location.landing_page_url
    : (doi ? 'https://doi.org/' + doi : (work.id || ''));

  const publishedDate = work.publication_date || '';

  // OpenAlex sometimes carries the arXiv ID in primary_location for
  // preprints indexed from arXiv — extract it if present, so an
  // OpenAlex-discovered preprint still dedupes correctly against the
  // same paper found directly via fetchArxiv.gs.
  const arxivId = extractArxivIdFromOpenAlexWork(work);

  try {
    return makeNormalizedPaper({
      title: title,
      authors: authors,
      abstract: abstract,
      link: link,
      source: 'openalex',
      publishedDate: publishedDate,
      doi: doi,
      arxivId: arxivId,
      philpapersId: null,
    });
  } catch (err) {
    Logger.log('mapOpenAlexWorkToNormalizedPaper: skipping work due to: %s', err);
    return null;
  }
}

/**
 * OpenAlex returns abstracts as {word: [position, position, ...]} so that
 * abstract text can be reconstructed by anyone who wants it, without
 * OpenAlex itself redistributing full copyrighted text directly. This
 * rebuilds the plain-text abstract from that structure.
 *
 * @param {Object|null|undefined} invertedIndex
 * @return {string}
 */
function reconstructAbstractFromInvertedIndex(invertedIndex) {
  if (!invertedIndex) return '';

  const positionToWord = [];
  Object.keys(invertedIndex).forEach(function(word) {
    invertedIndex[word].forEach(function(position) {
      positionToWord[position] = word;
    });
  });

  return positionToWord.join(' ').trim();
}

/**
 * Looks for an arXiv ID hiding in an OpenAlex work's locations (some
 * preprints have their primary or alternate location pointing at arxiv.org).
 *
 * @param {Object} work
 * @return {string|null}
 */
function extractArxivIdFromOpenAlexWork(work) {
  const locations = [];
  if (work.primary_location) locations.push(work.primary_location);
  if (work.locations) locations.push.apply(locations, work.locations);

  for (let i = 0; i < locations.length; i++) {
    const url = locations[i] && locations[i].landing_page_url;
    if (url && url.indexOf('arxiv.org') !== -1) {
      const match = url.match(/abs\/([^\/?]+)/);
      if (match) return match[1];
    }
  }

  return null;
}
