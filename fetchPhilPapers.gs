/**
 * fetchPhilPapers.gs
 *
 * IMPORTANT LIMITATION — read this before changing anything below:
 *
 * PhilPapers does NOT expose a general "search by keyword" REST/JSON API.
 * Their documented JSON API only serves the category taxonomy (requires
 * a free API key), not paper search. See:
 *   https://philpapers.org/help/api/json.html
 *
 * What IS confirmed and usable without any key is their OAI-PMH endpoint:
 *   https://philpapers.org/oai.pl
 * BUT — and this matters — OAI-PMH only exposes USER-SUBMITTED, OPEN
 * ACCESS content (i.e. papers authors have personally uploaded to
 * PhilPapers' archive). It does NOT cover PhilPapers' full index, which
 * includes paywalled journal articles indexed via publisher metadata.
 * Source: https://philpapers.org/help/oai.html
 *
 * Practical effect: this fetcher will find self-archived preprints and
 * open-access papers that authors uploaded directly to PhilPapers, but
 * will MISS new paywalled journal articles that PhilPapers indexes via
 * other means. That's a real gap relative to "everything new on
 * PhilPapers" — but Crossref (fetchCrossref.gs) already catches most
 * traditionally-published journal articles regardless of source, so the
 * overlap in practice should be smaller than it sounds.
 *
 * If you later get a PhilPapers API key/ID (free, see the JSON API
 * page) and PhilPapers adds keyword search to that JSON API in the
 * future, this file is the place to switch over — the rest of the
 * pipeline (normalize/dedupe/relevance/write) doesn't care which
 * approach this file uses internally.
 *
 * OAI-PMH protocol basics used here:
 *   ListRecords with metadataPrefix=oai_dc and a `from` date filters by
 *   the record's last-modified date. We then filter by the relevance
 *   rules (config.gs section 1) client-side, the same way fetchArxiv.gs filters by date client-side,
 *   since OAI-PMH has no keyword search of its own.
 *
 * OLD PAPERS RE-ENTERING AS NEW
 * -----------------------------
 * The `from` date is the date a RECORD was added or edited, not when the
 * paper was published. So an author uploading a years-old paper today makes
 * it look new. Dublin Core records also carry dc:date, the paper's own date
 * (usually just a year). Records whose latest dc:date year is older than
 * SOURCE_SETTINGS.philpapers.maxAgeYears (config.gs) are dropped. A record
 * with no usable dc:date is kept (fail open), so nothing genuinely new is
 * lost to missing metadata.
 */

const PHILPAPERS_OAI_BASE = 'https://philpapers.org/oai.pl';

/**
 * Fetches recently-added PhilPapers OAI records and filters to those
 * matching the relevance rules (config.gs section 1) and recent enough to
 * be new work.
 *
 * @return {NormalizedPaper[]}
 */
function fetchPhilPapers() {
  const cutoff = getLookbackCutoffDate();
  const records = fetchPhilPapersOaiRecords(cutoff);

  // OAI-PMH gives us everything in the date window, regardless of topic —
  // filter here so we don't normalize records we're about to throw away.
  const onTopic = records.filter(recordMentionsAnyTopic);

  const recent = onTopic.filter(function(record) {
    if (isOldPhilPapersRecord(record)) {
      Logger.log('fetchPhilPapers: skipping old paper re-indexed as new (%s): %s',
        record.paperYears.join('/'), record.title);
      return false;
    }
    return true;
  });

  return recent
    .map(mapOaiRecordToNormalizedPaper)
    .filter(function(paper) { return paper !== null; });
}

/**
 * True if the record's own publication year (dc:date) is older than
 * SOURCE_SETTINGS.philpapers.maxAgeYears. Uses the LATEST year found, so a
 * paper with an old original date and a new revision date is kept.
 *
 * @param {Object} record - From parsePhilPapersOaiResponse
 * @return {boolean}
 */
function isOldPhilPapersRecord(record) {
  const maxAgeYears = SOURCE_SETTINGS.philpapers.maxAgeYears;
  if (typeof maxAgeYears !== 'number') return false;
  if (!record.paperYears || record.paperYears.length === 0) return false;

  const latestYear = Math.max.apply(null, record.paperYears);
  const oldestAllowedYear = new Date().getFullYear() - maxAgeYears;
  return latestYear < oldestAllowedYear;
}

/**
 * Calls the OAI-PMH ListRecords verb and parses the response.
 * Handles pagination via resumptionToken, capped at a sane number of
 * pages so a misconfigured date range can't cause a runaway loop.
 *
 * @param {string} fromDate - ISO 'YYYY-MM-DD'
 * @return {Array<Object>}
 */
function fetchPhilPapersOaiRecords(fromDate) {
  const settings = SOURCE_SETTINGS.philpapers;
  const allRecords = [];
  const MAX_PAGES = 5; // safety cap — resumptionToken pagination guard

  let resumptionToken = null;
  let page = 0;

  do {
    const url = resumptionToken
      ? PHILPAPERS_OAI_BASE + '?verb=ListRecords&resumptionToken=' + encodeURIComponent(resumptionToken)
      : PHILPAPERS_OAI_BASE + '?verb=ListRecords&metadataPrefix=oai_dc&from=' + fromDate;

    let response;
    try {
      response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    } catch (err) {
      Logger.log('fetchPhilPapersOaiRecords: request failed: %s', err);
      break;
    }

    if (response.getResponseCode() !== 200) {
      Logger.log(
        'fetchPhilPapersOaiRecords: non-200 response (%s)',
        response.getResponseCode()
      );
      break;
    }

    const parsed = parsePhilPapersOaiResponse(response.getContentText());
    allRecords.push.apply(allRecords, parsed.records);
    resumptionToken = parsed.resumptionToken;
    page++;

    if (allRecords.length >= settings.maxResults) break;
  } while (resumptionToken && page < MAX_PAGES);

  return allRecords;
}

/**
 * Parses an OAI-PMH ListRecords XML response (Dublin Core metadata
 * format) into plain JS objects, plus the resumptionToken if present.
 *
 * @param {string} xmlText
 * @return {{records: Array, resumptionToken: string|null}}
 */
function parsePhilPapersOaiResponse(xmlText) {
  const document = XmlService.parse(xmlText);
  const root = document.getRootElement();
  const oaiNs = XmlService.getNamespace('http://www.openarchives.org/OAI/2.0/');
  const dcNs = XmlService.getNamespace('http://purl.org/dc/elements/1.1/');
  const oaiDcNs = XmlService.getNamespace('oai_dc', 'http://www.openarchives.org/OAI/2.0/oai_dc/');

  const listRecords = root.getChild('ListRecords', oaiNs);
  if (!listRecords) {
    return { records: [], resumptionToken: null };
  }

  const recordElements = listRecords.getChildren('record', oaiNs);

  const records = recordElements.map(function(recordEl) {
    const header = recordEl.getChild('header', oaiNs);
    const identifier = header ? getChildText(header, 'identifier', oaiNs) : '';
    const datestamp = header ? getChildText(header, 'datestamp', oaiNs) : '';

    const metadata = recordEl.getChild('metadata', oaiNs);
    const dc = metadata ? metadata.getChild('dc', oaiDcNs) : null;

    const title = dc ? getChildText(dc, 'title', dcNs) : '';
    const description = dc ? getChildText(dc, 'description', dcNs) : '';

    const creatorElements = dc ? dc.getChildren('creator', dcNs) : [];
    const authors = creatorElements.map(function(el) { return el.getText().trim(); });

    // The paper's own date(s), as opposed to the record datestamp above.
    // Usually just "2024"; sometimes a full date. Keep only the years.
    const dateElements = dc ? dc.getChildren('date', dcNs) : [];
    const paperYears = [];
    dateElements.forEach(function(el) {
      const match = el.getText().match(/\b(1[5-9]\d{2}|20\d{2})\b/);
      if (match) paperYears.push(Number(match[1]));
    });

    // PhilPapers OAI records sometimes carry the canonical web URL as one
    // of several dc:identifier or dc:relation elements rather than the
    // OAI identifier itself — fall back to the OAI identifier if no
    // better URL is found.
    const identifierElements = dc ? dc.getChildren('identifier', dcNs) : [];
    let link = identifier;
    for (let i = 0; i < identifierElements.length; i++) {
      const text = identifierElements[i].getText().trim();
      if (text.indexOf('http') === 0) {
        link = text;
        break;
      }
    }

    return {
      title: title,
      authors: authors,
      description: description,
      identifier: identifier,
      link: link,
      date: datestamp ? datestamp.slice(0, 10) : '',
      paperYears: paperYears,
    };
  });

  const resumptionTokenEl = listRecords.getChild('resumptionToken', oaiNs);
  const resumptionToken = resumptionTokenEl ? resumptionTokenEl.getText().trim() : null;

  return {
    records: records,
    // An empty resumptionToken element means "no more pages" — treat
    // empty string the same as absent.
    resumptionToken: resumptionToken || null,
  };
}

/**
 * Checks whether a raw OAI record's title or description passes the
 * relevance rules. Same rules as relevanceFilter.gs, but applied
 * here (pre-normalization) to avoid normalizing records we're about to
 * discard — see file header for why this filtering happens in this file
 * rather than relying solely on the shared relevanceFilter.gs pass later.
 * (The shared filter still runs too, downstream, as a second pass — this
 * is just an efficiency short-circuit, not a replacement for it.)
 *
 * @param {Object} record - From parsePhilPapersOaiResponse
 * @return {boolean}
 */
function recordMentionsAnyTopic(record) {
  return evaluateRelevanceText(record.title, record.description).isRelevant;
}

/**
 * Maps a parsed OAI record into a NormalizedPaper.
 *
 * @param {Object} record - From parsePhilPapersOaiResponse
 * @return {NormalizedPaper|null}
 */
function mapOaiRecordToNormalizedPaper(record) {
  if (!record.title) return null;

  try {
    return makeNormalizedPaper({
      title: record.title,
      authors: record.authors.join(', '),
      abstract: record.description,
      link: record.link,
      source: 'philpapers',
      publishedDate: record.date,
      doi: null, // Dublin Core from this endpoint doesn't reliably expose DOI
      arxivId: null,
      philpapersId: extractPhilPapersIdFromOaiIdentifier(record.identifier),
    });
  } catch (err) {
    Logger.log('mapOaiRecordToNormalizedPaper: skipping record due to: %s', err);
    return null;
  }
}

/**
 * OAI identifiers look like "oai:philpapers.org:REC-12345" — pulls out
 * the trailing record ID portion for storage in the philpapersId column.
 *
 * @param {string} oaiIdentifier
 * @return {string|null}
 */
function extractPhilPapersIdFromOaiIdentifier(oaiIdentifier) {
  const match = String(oaiIdentifier || '').match(/:([^:]+)$/);
  return match ? match[1] : (oaiIdentifier || null);
}
