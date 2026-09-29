/**
 * fetchArxiv.gs
 *
 * Searches arXiv's API (no key required) for recent papers matching
 * ARXIV_QUERIES (config.gs, section 1B), across ALL arXiv categories, and
 * maps each result into a NormalizedPaper (see normalize.gs).
 *
 * Why search by phrase rather than by category: pulling the newest papers
 * in a few categories regardless of topic misses relevant work posted under
 * other categories, and fills the feed with unrelated papers from the
 * chosen ones. This asks arXiv only for papers whose abstract matches your
 * search phrases, wherever they were posted.
 *
 * API docs: https://info.arxiv.org/help/api/user-manual.html
 * Query syntax: https://info.arxiv.org/help/api/user-manual.html#query_details
 * Rate limit: arXiv asks for no more than 1 request every 3 seconds, so
 * this waits 3 seconds between requests. To keep the request count low,
 * several ARXIV_QUERIES entries are OR-ed into each request, packed as
 * tightly as Apps Script's 2 KB URL limit allows (a run makes roughly 6–10
 * requests, including extra pages in a busy week).
 */

const ARXIV_API_BASE = 'http://export.arxiv.org/api/query';
const ARXIV_REQUEST_GAP_MS = 3000;

// Apps Script's UrlFetchApp rejects URLs longer than 2 KB (2048 chars).
// Leave room for the paging parameters.
const ARXIV_MAX_URL_LENGTH = 1900;

/**
 * Fetches recent arXiv papers matching any query in ARXIV_QUERIES.
 *
 * @return {NormalizedPaper[]}
 */
function fetchArxiv() {
  const settings = SOURCE_SETTINGS.arxiv;
  const cutoff = getLookbackCutoffDate();
  const batches = packArxivClauses(ARXIV_QUERIES.map(buildArxivQueryClause));
  const allPapers = [];
  let isFirstRequest = true;

  batches.forEach(function(searchQuery) {

    for (let page = 0; page < settings.maxPages; page++) {
      if (!isFirstRequest) {
        Utilities.sleep(ARXIV_REQUEST_GAP_MS);
      }
      isFirstRequest = false;

      const entries = fetchArxivPage(searchQuery, page * settings.pageSize, settings.pageSize);
      if (entries === null) break; // request failed; already logged

      const recent = entries.filter(function(entry) {
        // arXiv can't filter by date in the query, so filter here.
        return entry.publishedDate >= cutoff;
      });
      recent.forEach(function(entry) {
        allPapers.push(mapArxivEntryToNormalizedPaper(entry));
      });

      // Results are newest first, so stop paging once a page runs out of
      // results or reaches papers older than the lookback window.
      const reachedOlderPapers = recent.length < entries.length;
      if (entries.length < settings.pageSize || reachedOlderPapers) break;
    }
  });

  return allPapers;
}

/**
 * Turns one ARXIV_QUERIES entry into an arXiv search clause.
 *   'AI welfare'                        -> abs:"AI welfare"
 *   ['consciousness', ['LLM', 'LLMs']]  -> (abs:"consciousness" AND (abs:"LLM" OR abs:"LLMs"))
 *
 * @param {string|Array} entry
 * @return {string}
 */
function buildArxivQueryClause(entry) {
  if (Array.isArray(entry)) {
    // Outer list: every part must match (AND). A part that is itself a
    // list: any of its phrases may match (OR).
    return '(' + entry.map(function(part) {
      if (Array.isArray(part)) {
        return '(' + part.map(buildArxivPhraseClause).join(' OR ') + ')';
      }
      return buildArxivPhraseClause(part);
    }).join(' AND ') + ')';
  }
  return buildArxivPhraseClause(entry);
}

/**
 * Abstract match for one exact phrase. Title is not searched separately:
 * it would double the URL length, and a paper whose title uses a phrase
 * almost always uses it in the abstract too.
 *
 * @param {string} phrase
 * @return {string}
 */
function buildArxivPhraseClause(phrase) {
  return 'abs:"' + String(phrase).replace(/"/g, '') + '"';
}

/**
 * Packs clauses into as few search queries as possible, OR-ing clauses
 * together while the resulting request URL stays under
 * ARXIV_MAX_URL_LENGTH. A clause too long to share a request goes alone.
 *
 * @param {string[]} clauses
 * @return {string[]} One search_query value per request.
 */
function packArxivClauses(clauses) {
  const baseLength = (ARXIV_API_BASE +
    '?search_query=&sortBy=submittedDate&sortOrder=descending&start=000&max_results=000').length;
  const fits = function(query) {
    return baseLength + encodeArxivQuery(query).length <= ARXIV_MAX_URL_LENGTH;
  };

  const queries = [];
  let current = '';
  clauses.forEach(function(clause) {
    const candidate = current ? current + ' OR ' + clause : clause;
    if (!current || fits(candidate)) {
      current = candidate;
    } else {
      queries.push(current);
      current = clause;
    }
  });
  if (current) queries.push(current);

  queries.forEach(function(query) {
    if (!fits(query)) {
      Logger.log('fetchArxiv: a single ARXIV_QUERIES entry is too long for ' +
        'one request and will likely fail: %s', query.slice(0, 200));
    }
  });
  return queries;
}

/**
 * Percent-encodes a search_query value. encodeURIComponent leaves "(" and
 * ")" as they are; arXiv's documentation asks for them as %28 and %29.
 *
 * @param {string} query
 * @return {string}
 */
function encodeArxivQuery(query) {
  return encodeURIComponent(query).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/**
 * Fetches one page of search results, newest submissions first.
 *
 * @param {string} searchQuery - arXiv search_query value (not yet encoded).
 * @param {number} start - Index of the first result to return.
 * @param {number} pageSize
 * @return {Array|null} Parsed entries (see parseArxivAtomFeed), or null if
 *         the request failed.
 */
function fetchArxivPage(searchQuery, start, pageSize) {
  const url =
    ARXIV_API_BASE +
    '?search_query=' + encodeArxivQuery(searchQuery) +
    '&sortBy=submittedDate' +
    '&sortOrder=descending' +
    '&start=' + start +
    '&max_results=' + pageSize;

  let response;
  try {
    response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) {
    Logger.log('fetchArxivPage: request failed: %s', err);
    return null;
  }

  if (response.getResponseCode() !== 200) {
    Logger.log(
      'fetchArxivPage: non-200 response (%s). Body (first 300 chars): %s',
      response.getResponseCode(),
      response.getContentText().slice(0, 300)
    );
    return null;
  }

  return parseArxivAtomFeed(response.getContentText());
}

/**
 * Maps one parsed arXiv entry into a NormalizedPaper.
 *
 * @param {Object} entry - From parseArxivAtomFeed.
 * @return {NormalizedPaper}
 */
function mapArxivEntryToNormalizedPaper(entry) {
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
}

/**
 * Parses arXiv's Atom XML feed into plain JS objects.
 * Kept separate from fetchArxivPage so it can be unit-tested against
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
