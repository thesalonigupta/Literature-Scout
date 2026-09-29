/**
 * fetchPubMed.gs (OPTIONAL SOURCE — not wired into main.gs by default)
 *
 * Queries PubMed (via NCBI's E-utilities API) for recent papers matching
 * your topics. No API key required.
 *
 * WHEN TO ADD THIS: PubMed indexes biomedical, veterinary, agricultural,
 * and life-science journals far more thoroughly than Crossref does, and —
 * critically — PubMed records almost always include the actual abstract
 * text, which Crossref frequently lacks (see fetchCrossref.gs's note on
 * this). If your field touches biology, medicine, public health,
 * veterinary/animal science, nutrition, epidemiology, or psychology, this
 * is likely worth adding. If your field is purely humanities, law, or
 * social science with no life-science overlap, skip it — you'll mostly
 * get zero-candidate topics and wasted API calls.
 *
 * HOW TO WIRE THIS IN (this file alone isn't enough):
 *   1. Copy this file into your Apps Script project as `fetchPubMed`.
 *   2. In config.gs, add to SOURCES_ENABLED: `pubmed: true,`
 *   3. In config.gs, add to SOURCE_SETTINGS:
 *        pubmed: {
 *          maxResults: 30,
 *          contactEmail: 'YOUR_CONTACT_EMAIL@example.org', // same idea as Crossref's politeEmail
 *        },
 *   4. In main.gs, add to both runLiteratureScout() and
 *      testFetchAllSourcesWithoutWriting():
 *        if (SOURCES_ENABLED.pubmed) {
 *          candidates = candidates.concat(safelyFetch('pubmed', fetchPubMed, errors));
 *        }
 *      (and the Logger.log equivalent in the test function)
 *   5. Update DIGEST_HEADERS/DIGEST_COLUMNS in writeToSheet.gs only if you
 *      want a PubMed-specific column — not required, 'pubmed' just shows
 *      up as a normal value in the existing Source column.
 *
 * Two-step E-utilities workflow, once per query in FETCH_QUERIES (config.gs):
 *   1. ESearch: text query -> list of PMIDs (PubMed IDs)
 *   2. EFetch: PMIDs -> full XML records (title, abstract, authors, dates)
 *
 * API docs: https://www.ncbi.nlm.nih.gov/books/NBK25501/
 * Rate limit: NCBI asks for no more than 3 requests/second without an API
 * key (10/second with one). This pipeline stays comfortably under 3/sec
 * with the sleep below; an optional NCBI_API_KEY in Script Properties
 * (Project Settings > Script Properties) raises the limit further if
 * needed, but is NOT required for this pipeline's usage pattern.
 */

const PUBMED_ESEARCH_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_EFETCH_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';

/**
 * Fetches recent PubMed articles for every query in FETCH_QUERIES.
 *
 * @return {NormalizedPaper[]}
 */
function fetchPubMed() {
  const settings = SOURCE_SETTINGS.pubmed;
  const cutoff = getLookbackCutoffDate();
  const allPapers = [];

  FETCH_QUERIES.forEach(function(topic, index) {
    // Same rate-limit precaution as fetchOpenAlex.gs/fetchCrossref.gs —
    // NCBI's stated limit is 3 requests/sec without an API key; this
    // pipeline makes 2 requests per topic (ESearch + EFetch), so a sleep
    // before each topic's pair keeps the whole run comfortably under that.
    if (index > 0) {
      Utilities.sleep(350);
    }

    const papers = fetchPubMedForTopic(topic, cutoff, settings);
    allPapers.push.apply(allPapers, papers);
  });

  return allPapers;
}

/**
 * Fetches recent PubMed articles matching a single topic phrase.
 *
 * @param {string} topic
 * @param {string} cutoffDate - ISO 'YYYY-MM-DD'
 * @param {Object} settings - SOURCE_SETTINGS.pubmed
 * @return {NormalizedPaper[]}
 */
function fetchPubMedForTopic(topic, cutoffDate, settings) {
  const pmids = searchPubMedIds(topic, cutoffDate, settings);
  if (pmids.length === 0) return [];

  Utilities.sleep(350); // separate the ESearch and EFetch calls by the same margin

  const xmlText = fetchPubMedArticlesXml(pmids, settings);
  if (!xmlText) return [];

  return parsePubMedArticles(xmlText)
    .map(mapPubMedArticleToNormalizedPaper)
    .filter(function(paper) { return paper !== null; });
}

/**
 * Calls ESearch to get the list of PMIDs matching a topic within the
 * lookback window.
 *
 * @param {string} topic
 * @param {string} cutoffDate - ISO 'YYYY-MM-DD'
 * @param {Object} settings
 * @return {string[]} PMIDs, possibly empty.
 */
function searchPubMedIds(topic, cutoffDate, settings) {
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd');
  const mindate = cutoffDate.replace(/-/g, '/'); // PubMed wants YYYY/MM/DD

  const params = [
    'db=pubmed',
    'term=' + encodeURIComponent(topic),
    'retmode=json',
    'retmax=' + settings.maxResults,
    'datetype=pdat',
    'mindate=' + mindate,
    'maxdate=' + today,
    'tool=LiteratureScout',
    'email=' + encodeURIComponent(settings.contactEmail),
  ];

  const apiKey = getNcbiApiKeyOptional();
  if (apiKey) {
    params.push('api_key=' + encodeURIComponent(apiKey));
  }

  const url = PUBMED_ESEARCH_BASE + '?' + params.join('&');

  let response;
  try {
    response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) {
    Logger.log('searchPubMedIds: request failed for topic "%s": %s', topic, err);
    return [];
  }

  if (response.getResponseCode() !== 200) {
    Logger.log(
      'searchPubMedIds: non-200 response (%s) for topic "%s"',
      response.getResponseCode(),
      topic
    );
    return [];
  }

  let json;
  try {
    json = JSON.parse(response.getContentText());
  } catch (err) {
    Logger.log('searchPubMedIds: failed to parse JSON for topic "%s": %s', topic, err);
    return [];
  }

  return (json.esearchresult && json.esearchresult.idlist) || [];
}

/**
 * Calls EFetch to get full XML records for a batch of PMIDs.
 *
 * @param {string[]} pmids
 * @param {Object} settings
 * @return {string|null} Raw XML text, or null on failure.
 */
function fetchPubMedArticlesXml(pmids, settings) {
  const params = [
    'db=pubmed',
    'id=' + pmids.join(','),
    'retmode=xml',
    'tool=LiteratureScout',
    'email=' + encodeURIComponent(settings.contactEmail),
  ];

  const apiKey = getNcbiApiKeyOptional();
  if (apiKey) {
    params.push('api_key=' + encodeURIComponent(apiKey));
  }

  const url = PUBMED_EFETCH_BASE + '?' + params.join('&');

  let response;
  try {
    response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) {
    Logger.log('fetchPubMedArticlesXml: request failed: %s', err);
    return null;
  }

  if (response.getResponseCode() !== 200) {
    Logger.log('fetchPubMedArticlesXml: non-200 response (%s)', response.getResponseCode());
    return null;
  }

  return response.getContentText();
}

/**
 * Parses an EFetch PubmedArticleSet XML response into plain JS element
 * objects (one per PubmedArticle). PubMed's XML is unnamespaced, unlike
 * arXiv's Atom feed or PhilPapers' OAI-PMH response.
 *
 * @param {string} xmlText
 * @return {GoogleAppsScript.XML_Service.Element[]}
 */
function parsePubMedArticles(xmlText) {
  let document;
  try {
    document = XmlService.parse(xmlText);
  } catch (err) {
    Logger.log('parsePubMedArticles: failed to parse XML: %s', err);
    return [];
  }

  const root = document.getRootElement();
  return root.getChildren('PubmedArticle');
}

/**
 * Maps a single <PubmedArticle> element into a NormalizedPaper.
 *
 * @param {GoogleAppsScript.XML_Service.Element} articleEl
 * @return {NormalizedPaper|null}
 */
function mapPubMedArticleToNormalizedPaper(articleEl) {
  try {
    const medlineCitation = articleEl.getChild('MedlineCitation');
    const article = medlineCitation ? medlineCitation.getChild('Article') : null;
    if (!article) return null;

    const pmid = medlineCitation.getChild('PMID')
      ? medlineCitation.getChild('PMID').getText().trim()
      : '';

    const title = getPlainChildText(article, 'ArticleTitle');

    const abstractEl = article.getChild('Abstract');
    const abstract = abstractEl
      ? abstractEl.getChildren('AbstractText')
          .map(function(el) { return el.getText().trim(); })
          .join(' ')
      : '';

    const authors = extractPubMedAuthors(article);
    const publishedDate = extractPubMedDate(article);
    const doi = extractPubMedDoi(articleEl);

    const link = pmid ? 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/' : '';

    return makeNormalizedPaper({
      title: title,
      authors: authors,
      abstract: abstract,
      link: link,
      source: 'pubmed',
      publishedDate: publishedDate,
      doi: doi,
      arxivId: null,
      philpapersId: null,
    });
  } catch (err) {
    Logger.log('mapPubMedArticleToNormalizedPaper: skipping article due to: %s', err);
    return null;
  }
}

/**
 * Extracts a joined "LastName ForeName, LastName ForeName, ..." author
 * string from an <Article> element's <AuthorList>. Falls back to
 * <CollectiveName> for group-authored papers.
 *
 * @param {GoogleAppsScript.XML_Service.Element} articleEl
 * @return {string}
 */
function extractPubMedAuthors(articleEl) {
  const authorList = articleEl.getChild('AuthorList');
  if (!authorList) return '';

  return authorList.getChildren('Author')
    .map(function(authorEl) {
      const collective = authorEl.getChild('CollectiveName');
      if (collective) return collective.getText().trim();

      const lastName = getPlainChildText(authorEl, 'LastName');
      const foreName = getPlainChildText(authorEl, 'ForeName');
      return (foreName + ' ' + lastName).trim();
    })
    .filter(function(name) { return name.length > 0; })
    .join(', ');
}

/**
 * Extracts a best-effort ISO 'YYYY-MM-DD' publication date from an
 * <Article>'s <Journal>/<JournalIssue>/<PubDate>. PubMed dates are messy:
 * Month can be a number, a 3-letter name, or absent; some records only
 * carry a free-text <MedlineDate> (e.g. "2026 Jul-Aug") instead of
 * separate Year/Month/Day. Falls back to whatever precision is available
 * rather than failing — same philosophy as isPlausiblePublishedDate() in
 * normalize.gs, which tolerates imprecise/odd dates from sources.
 *
 * @param {GoogleAppsScript.XML_Service.Element} articleEl
 * @return {string} ISO date string, or '' if nothing usable was found.
 */
function extractPubMedDate(articleEl) {
  const journal = articleEl.getChild('Journal');
  const pubDate = journal && journal.getChild('JournalIssue')
    ? journal.getChild('JournalIssue').getChild('PubDate')
    : null;
  if (!pubDate) return '';

  const year = getPlainChildText(pubDate, 'Year');
  if (year) {
    const monthRaw = getPlainChildText(pubDate, 'Month');
    const day = getPlainChildText(pubDate, 'Day') || '01';
    const month = normalizePubMedMonth(monthRaw);
    return year + '-' + month + '-' + day.padStart(2, '0');
  }

  // No structured Year — try to pull a 4-digit year out of MedlineDate.
  const medlineDate = getPlainChildText(pubDate, 'MedlineDate');
  const yearMatch = medlineDate.match(/\d{4}/);
  return yearMatch ? yearMatch[0] + '-01-01' : '';
}

/**
 * Converts a PubMed <Month> value (numeric "07", or 3-letter "Jul") to a
 * zero-padded two-digit month string. Defaults to '01' for anything
 * unrecognized rather than failing the whole date.
 *
 * @param {string} monthRaw
 * @return {string}
 */
function normalizePubMedMonth(monthRaw) {
  if (!monthRaw) return '01';
  if (/^\d+$/.test(monthRaw)) return monthRaw.padStart(2, '0');

  const months = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  return months[monthRaw.toLowerCase().slice(0, 3)] || '01';
}

/**
 * Extracts the DOI from a <PubmedArticle>'s <PubmedData>/<ArticleIdList>,
 * looking for the <ArticleId> with IdType="doi".
 *
 * @param {GoogleAppsScript.XML_Service.Element} articleEl
 * @return {string|null}
 */
function extractPubMedDoi(articleEl) {
  const pubmedData = articleEl.getChild('PubmedData');
  const idList = pubmedData ? pubmedData.getChild('ArticleIdList') : null;
  if (!idList) return null;

  const ids = idList.getChildren('ArticleId');
  for (let i = 0; i < ids.length; i++) {
    if (ids[i].getAttribute('IdType') && ids[i].getAttribute('IdType').getValue() === 'doi') {
      return ids[i].getText().trim();
    }
  }
  return null;
}

/**
 * Safely gets the text content of a named, unnamespaced child element.
 * PubMed's XML has no namespaces, unlike arXiv's Atom feed — this is a
 * simpler counterpart to getChildText() in fetchArxiv.gs, which requires
 * a namespace argument.
 *
 * @param {GoogleAppsScript.XML_Service.Element} parent
 * @param {string} childName
 * @return {string}
 */
function getPlainChildText(parent, childName) {
  const child = parent.getChild(childName);
  return child ? child.getText().trim() : '';
}

/**
 * Reads an optional NCBI API key from Script Properties. Unlike
 * getOpenAlexApiKey() in fetchOpenAlex.gs, this does NOT throw if absent
 * — PubMed works fine without one at the lower (3 req/sec) rate limit.
 * Set NCBI_API_KEY in Script Properties only if you want the higher
 * (10 req/sec) limit.
 *
 * @return {string|null}
 */
function getNcbiApiKeyOptional() {
  const key = PropertiesService.getScriptProperties().getProperty('NCBI_API_KEY');
  return key ? key.trim() : null;
}
