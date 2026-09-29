/**
 * normalize.gs
 *
 * Every source (arXiv, Crossref, PhilPapers, OpenAlex) returns data in a
 * different shape. This file defines the ONE common shape every fetch
 * function must produce, so dedupe.gs / relevanceFilter.gs / writeToSheet.gs
 * never need to know or care which source a paper came from.
 *
 * If you add a new source later: write a fetchX.gs that calls the API and
 * maps its results through makeNormalizedPaper() below. That's the only
 * integration point.
 */

/**
 * The common paper shape. Every fetch*.gs file must produce an array of
 * objects matching this shape.
 *
 * @typedef {Object} NormalizedPaper
 * @property {string} title           - Paper title, whitespace-collapsed.
 * @property {string} authors         - Comma-separated author names as a
 *                                       single string (not an array) to
 *                                       keep the Sheet row simple.
 * @property {string} abstract        - Abstract/summary text. Empty string
 *                                       if the source didn't supply one.
 * @property {string} link            - URL to the paper's landing page
 *                                       (abstract page), not a raw PDF link.
 * @property {string} source          - Which fetch function found it, e.g.
 *                                       'arxiv', 'crossref', 'philpapers',
 *                                       'openalex'. Used for the Sheet's
 *                                       Source column and for debugging.
 * @property {string} publishedDate   - ISO 8601 date string (YYYY-MM-DD).
 *                                       Use the earliest date the source
 *                                       gives you (submission date for
 *                                       preprints, not revision date).
 * @property {string|null} doi        - Normalized DOI (see normalizeDoi),
 *                                       or null if the source has none.
 * @property {string|null} arxivId    - Normalized arXiv ID with version
 *                                       suffix stripped (see
 *                                       normalizeArxivId), or null.
 * @property {string|null} philpapersId - Raw PhilPapers ID, or null.
 * @property {string|null} language  - Language code the SOURCE reports
 *                                       (e.g. 'en', 'it'), lowercased, or
 *                                       null if the source doesn't say.
 *                                       Crossref and OpenAlex supply it;
 *                                       arXiv and PhilPapers don't.
 * @property {string} titleHash       - Computed automatically by
 *                                       makeNormalizedPaper(); do not set
 *                                       this yourself.
 */

/**
 * Builds a NormalizedPaper object and computes its titleHash.
 * ALWAYS use this constructor in fetch*.gs files rather than building the
 * object literal by hand — it guarantees the titleHash is computed
 * consistently and that no required field is silently missing.
 *
 * @param {Object} fields - All NormalizedPaper fields except titleHash.
 * @return {NormalizedPaper}
 */
function makeNormalizedPaper(fields) {
  const title = (fields.title || '').trim();

  if (!title) {
    // A paper with no title can't be meaningfully deduped or displayed.
    // Fail loudly here rather than silently writing a blank Sheet row.
    throw new Error(
      'makeNormalizedPaper: title is required but was empty. ' +
      'Source: ' + (fields.source || 'unknown')
    );
  }

  const publishedDate = fields.publishedDate || '';
  if (publishedDate && !isPlausiblePublishedDate(publishedDate)) {
    // Observed in practice: a Crossref record dated 2106-01-01, an
    // OpenAlex record dated 2050-01-01 — both are typos/errors in the
    // SOURCE's own metadata, not a parsing bug here. We still keep the
    // paper (dropping a real, relevant result over a metadata quirk
    // would be worse) but log it so a nonsensical date in the Sheet is
    // immediately traceable to "known upstream data issue" rather than
    // mistaken for a bug in this pipeline later.
    Logger.log(
      'makeNormalizedPaper: "%s" (source: %s) has an implausible ' +
      'publishedDate ("%s") — likely bad metadata from the source ' +
      'itself. Paper is kept; only the Published Date column may look ' +
      'wrong. Check the Link column to verify against the source.',
      title, fields.source || 'unknown', publishedDate
    );
  }

  return {
    title: collapseWhitespace(title),
    authors: collapseWhitespace(fields.authors || ''),
    abstract: collapseWhitespace(fields.abstract || ''),
    link: sanitizeLink(fields.link || ''),
    source: fields.source || 'unknown',
    publishedDate: publishedDate,
    doi: normalizeDoi(fields.doi),
    arxivId: normalizeArxivId(fields.arxivId),
    philpapersId: fields.philpapersId ? String(fields.philpapersId).trim() : null,
    language: fields.language ? String(fields.language).trim().toLowerCase() : null,
    titleHash: computeTitleHash(title),
  };
}

/**
 * Trims stray characters that occasionally show up around a URL in
 * source metadata. Observed in practice: an OpenAlex record whose
 * primary_location.landing_page_url was
 * "https://orcid.org/0009-0006-7986-4646>" — a trailing ">" baked into
 * the source's own data, which would otherwise break the hyperlink in
 * both the Sheet and Slack. This is a narrow defensive trim, not a full
 * URL validator/parser.
 *
 * @param {string} raw
 * @return {string}
 */
function sanitizeLink(raw) {
  return String(raw || '')
    .trim()
    .replace(/^[<\s]+/, '')
    .replace(/[>\s]+$/, '');
}

/**
 * Sanity-checks a publishedDate string against a plausible range. This is
 * NOT a correctness guarantee for the date — it only catches OBVIOUS
 * upstream data errors (seen in practice: a Crossref record dated
 * 2106-01-01, an OpenAlex record dated 2050-01-01). A generous
 * two-year-from-now buffer is deliberate: academic publishers routinely
 * assign a "publication date" to a future print issue (a paper available
 * online in July 2026 but formally dated to a Volume/Issue that prints
 * in late 2027 or early 2028 is normal, not an error) — narrowing this
 * buffer to catch that would just replace one kind of noise with another.
 *
 * @param {string} dateStr - ISO 'YYYY-MM-DD'
 * @return {boolean}
 */
function isPlausiblePublishedDate(dateStr) {
  const parsed = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(parsed.getTime())) return false;

  const twoYearsFromNow = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000);
  const earliestPlausible = new Date('1900-01-01T00:00:00Z');

  return parsed <= twoYearsFromNow && parsed >= earliestPlausible;
}

/**
 * Normalizes a DOI to a consistent lowercase form with no URL prefix.
 * Handles the common variants seen across sources:
 *   "https://doi.org/10.1234/Abc.123" -> "10.1234/abc.123"
 *   "doi:10.1234/Abc.123"             -> "10.1234/abc.123"
 *   "10.1234/Abc.123"                 -> "10.1234/abc.123"
 *
 * @param {string|null|undefined} raw
 * @return {string|null} Normalized DOI, or null if input was empty.
 */
function normalizeDoi(raw) {
  if (!raw) return null;
  let doi = String(raw).trim();
  if (!doi) return null;

  doi = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  doi = doi.replace(/^doi:\s*/i, '');
  doi = doi.toLowerCase();

  return doi || null;
}

/**
 * Normalizes an arXiv ID, stripping the version suffix so that "2506.12345"
 * and "2506.12345v2" are recognized as the same paper. This is the single
 * most important normalization in the whole pipeline — without it, every
 * abstract revision an author makes would look like a brand-new paper and
 * generate a duplicate row / duplicate Slack post.
 *
 * Handles both modern (YYMM.NNNNN) and legacy (category/YYMMNNN) formats.
 *
 * @param {string|null|undefined} raw
 * @return {string|null}
 */
function normalizeArxivId(raw) {
  if (!raw) return null;
  let id = String(raw).trim();
  if (!id) return null;

  // Strip a leading "arXiv:" prefix if present.
  id = id.replace(/^arxiv:\s*/i, '');

  // Strip a trailing version suffix like "v1", "v2", etc.
  id = id.replace(/v\d+$/i, '');

  return id.toLowerCase() || null;
}

/**
 * Collapses any run of whitespace (including newlines) into a single
 * space, and trims the ends. Used on every text field so that minor
 * formatting differences between sources (line breaks in an abstract,
 * double spaces) don't affect comparisons or display.
 *
 * @param {string} text
 * @return {string}
 */
function collapseWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Computes a stable hash of a normalized title, used as the last-resort
 * dedupe key when neither DOI nor arXiv ID is available (see dedupe.gs).
 *
 * Normalization before hashing:
 *   - lowercase
 *   - strip all punctuation (keeps only letters, numbers, spaces)
 *   - collapse whitespace
 * This means "The Ethics of AI Welfare!" and "the ethics of ai welfare"
 * hash identically, but two genuinely different titles that happen to
 * share most words will NOT collide (hashing, not fuzzy matching).
 *
 * Letters and numbers are matched with Unicode classes (\p{L}, \p{N}), not
 * \w. \w is ASCII-only in JavaScript, so it used to strip every character
 * of a non-Latin title: a fully Japanese or Arabic title normalized to ""
 * and hashed to d41d8cd98f00b204e9800998ecf8427e (the MD5 of an empty
 * string), which made every such title a "duplicate" of the first one.
 * For pure-ASCII titles the output is identical to the old \w version
 * (underscore is kept deliberately), so existing hashes in the Sheet stay
 * valid.
 *
 * @param {string} title - Raw (not yet normalized) title.
 * @return {string} Hex-encoded hash string.
 */
function computeTitleHash(title) {
  let normalized = String(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s]/gu, '') // strip punctuation, keep letters/numbers/space in any script
    .replace(/\s+/g, ' ')
    .trim();

  // Titles made entirely of punctuation/symbols would still normalize to ""
  // and collide with each other. Hash the raw title instead.
  if (!normalized) {
    normalized = String(title).trim();
  }

  // Apps Script provides Utilities.computeDigest for hashing — MD5 is
  // plenty here since this is a dedupe key, not a security boundary.
  const rawHash = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    normalized,
    Utilities.Charset.UTF_8
  );

  return rawHash
    .map(function(byte) {
      const hex = (byte & 0xff).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    })
    .join('');
}
