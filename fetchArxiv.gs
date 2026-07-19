/**
 * fetchArxiv.gs
 *
 * Queries arXiv's API (no key required) for recent papers in the
 * categories configured in config.gs, and maps each result into a
 * NormalizedPaper (see normalize.gs).
 *
 * API docs: https://info.arxiv.org/help/api/user-manual.html
 * Rate limit: arXiv asks for no more than 1 request every 3 seconds.
 * This function makes a small, fixed number of requests per run (one per
 * configured category), so it stays comfortably within that limit without
 * needing an explicit sleep — but if you ever add many more categories,
 * add a Utilities.sleep(3000) between requests.
 */

const ARXIV_API_BASE = 'http://export.arxiv.org/api/query';

/**
 * Fetches recent arXiv papers across all configured categories.
 *
 * @return {NormalizedPaper[]}
 */
function fetchArxiv() {
  const settings = SOURCE_SETTINGS.arxiv;
  const allPapers = [];

  settings.categories.forEach(function(category) {
    const papers = fetchArxivCategory(category, settings.maxResults);
    allPapers.push.apply(allPapers, papers);
  });

  return allPapers;
}

/**
 * Fetches recent papers for a single arXiv category.
 *
 * @param {string} category - e.g. 'cs.AI'
 * @param {number} maxResults
 * @return {NormalizedPaper[]}
 */
function fetchArxivCategory(category, maxResults) {
  const query =
    ARXIV_API_BASE +
    '?search_query=' + encodeURIComponent('cat:' + category) +
    '&sortBy=submittedDate' +
    '&sortOrder=descending' +
    '&max_results=' + maxResults;

  let response;
  try {
    response = UrlFetchApp.fetch(query, { muteHttpExceptions: true });
  } catch (err) {
    Logger.log('fetchArxivCategory: request failed for category %s: %s', category, err);
    return [];
  }

  if (response.getResponseCode() !== 200) {
    Logger.log(
      'fetchArxivCategory: non-200 response (%s) for category %s',
      response.getResponseCode(),
      category
    );
    return [];
  }

  const entries = parseArxivAtomFeed(response.getContentText());
  const cutoff = getLookbackCutoffDate();

  return entries
    .filter(function(entry) {
      // arXiv's API sorts by submittedDate but doesn't let us filter by
      // date directly in the query, so we filter client-side here.
      return entry.publishedDate >= cutoff;
    })
    .map(function(entry) {
      return makeNormalizedPaper({
        title: entry.title,
        authors: entry.authors.join(', '),
        abstract: entry.summary,
        link: entry.link,
        source: 'arxiv',
        publishedDate: entry.publishedDate,
        doi: entry.doi,
        arxivId: entry.arxivId,
        philpapersId: null,
      });
    });
}

/**
 * Parses arXiv's Atom XML feed into plain JS objects.
 * Kept separate from fetchArxivCategory so it can be unit-tested against
 * a saved sample response without making a real network call.
 *
 * @param {string} xmlText
 * @return {Array<{
 *   title: string, authors: string[], summary: string, link: string,
 *   publishedDate: string, arxivId: string, doi: string|null
 * }>}
 */
function parseArxivAtomFeed(xmlText) {
  const document = XmlService.parse(xmlText);
  const root = document.getRootElement();
  const atomNs = XmlService.getNamespace('http://www.w3.org/2005/Atom');
  const arxivNs = XmlService.getNamespace('arxiv', 'http://arxiv.org/schemas/atom');

  const entries = root.getChildren('entry', atomNs);

  return entries.map(function(entry) {
    const rawId = getChildText(entry, 'id', atomNs); // e.g. http://arxiv.org/abs/2506.12345v1
    const arxivId = extractArxivIdFromUrl(rawId);

    const authorElements = entry.getChildren('author', atomNs);
    const authors = authorElements.map(function(authorEl) {
      return getChildText(authorEl, 'name', atomNs);
    });

    const published = getChildText(entry, 'published', atomNs); // ISO datetime
    const publishedDate = published ? published.slice(0, 10) : '';

    const doiEl = entry.getChild('doi', arxivNs);
    const doi = doiEl ? doiEl.getText() : null;

    // Prefer the abstract-page link (rel="alternate") over the PDF link.
    const linkElements = entry.getChildren('link', atomNs);
    let link = rawId; // fallback: the id IS the abstract page URL
    for (let i = 0; i < linkElements.length; i++) {
      if (linkElements[i].getAttribute('rel') &&
          linkElements[i].getAttribute('rel').getValue() === 'alternate') {
        link = linkElements[i].getAttribute('href').getValue();
        break;
      }
    }

    return {
      title: getChildText(entry, 'title', atomNs),
      authors: authors,
      summary: getChildText(entry, 'summary', atomNs),
      link: link,
      publishedDate: publishedDate,
      arxivId: arxivId,
      doi: doi,
    };
  });
}

/**
 * Pulls the arXiv ID out of an abstract-page or id URL, e.g.
 * "http://arxiv.org/abs/2506.12345v1" -> "2506.12345v1"
 * (version suffix gets stripped later by normalizeArxivId in normalize.gs)
 *
 * @param {string} url
 * @return {string}
 */
function extractArxivIdFromUrl(url) {
  const match = String(url || '').match(/abs\/([^\/]+)$/);
  return match ? match[1] : url;
}

/**
 * Safely gets the text content of a named child element, returning an
 * empty string if the child doesn't exist (rather than throwing).
 *
 * @param {GoogleAppsScript.XML_Service.Element} parent
 * @param {string} childName
 * @param {GoogleAppsScript.XML_Service.Namespace} ns
 * @return {string}
 */
function getChildText(parent, childName, ns) {
  const child = parent.getChild(childName, ns);
  return child ? child.getText().trim() : '';
}
