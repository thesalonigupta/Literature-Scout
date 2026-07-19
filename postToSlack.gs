/**
 * postToSlack.gs
 *
 * Posts newly-added, relevant papers to a Slack channel via an Incoming
 * Webhook, right after they're written to the Digest sheet. This keeps
 * Slack and the Sheet as two views of the exact same data — nothing is
 * ever posted to Slack that isn't also a row in Digest.
 *
 * SETUP (one-time):
 *   1. In Slack: go to api.slack.com/apps > Create New App > From Scratch.
 *      Name it (e.g. "Literature Scout") and pick your workspace.
 *   2. In the app settings, open "Incoming Webhooks" and switch it on.
 *   3. Click "Add New Webhook to Workspace", choose the channel papers
 *      should post to, and allow it.
 *   4. Copy the Webhook URL Slack gives you (looks like
 *      https://hooks.slack.com/services/T00/B00/XXXXXXXX).
 *   5. In the Apps Script editor: gear icon (Project Settings) > Script
 *      Properties > Add script property.
 *        Property: SLACK_WEBHOOK_URL   Value: (paste the webhook URL)
 *      Same rule as OPENALEX_API_KEY: this is a credential, so it lives in
 *      Script Properties, never pasted into a code file.
 *   6. In config.gs, set SLACK.enabled to true. It defaults to false so a
 *      fresh copy of this tool never posts to a real channel before
 *      someone has deliberately turned it on.
 *   7. Run testFetchAllSourcesWithoutWriting (or just runLiteratureScout)
 *      once to confirm messages arrive. If nothing shows up, check the
 *      Run Log tab's Errors column first — Slack failures are recorded
 *      there the same way source-fetch failures are.
 */

/**
 * Posts one Slack message per paper in `papers`. Called from main.gs
 * (Step 5) after appendPapersToDigest(), using the same relevantNewPapers
 * list — so a Slack post and a Sheet row always correspond 1:1.
 *
 * Individual post failures (bad webhook response, transient network
 * error) are caught per-paper and returned as error strings rather than
 * thrown, so one failed message doesn't stop the rest of the batch or
 * the run as a whole — consistent with how safelyFetch() handles a
 * single failing source in main.gs.
 *
 * @param {NormalizedPaper[]} papers - Each must already have
 *        `matchedTopics` attached (see relevanceFilter.gs), same
 *        precondition as appendPapersToDigest().
 * @return {string[]} Error messages, if any. Empty array means all posts
 *         (or the digest summary) succeeded, or Slack posting is disabled.
 */
function postPapersToSlack(papers) {
  const errors = [];

  if (!SLACK.enabled) {
    return errors;
  }
  if (papers.length === 0) {
    return errors;
  }

  const webhookUrl = getSlackWebhookUrl();
  if (!webhookUrl) {
    errors.push(
      'Slack posting is enabled (SLACK.enabled = true in config.gs) but ' +
      'no SLACK_WEBHOOK_URL is set in Script Properties. See the setup ' +
      'steps at the top of postToSlack.gs.'
    );
    return errors;
  }

  // A run that turns up an unusually large batch (first-ever run, or one
  // after a long gap between runs) would otherwise fire one Slack message
  // per paper — spammy, and can trip Slack's per-webhook rate limit. Above
  // the threshold, send a single summary message instead of N individual
  // ones; every paper is still in the Sheet either way.
  if (papers.length > SLACK.maxIndividualPosts) {
    try {
      postSlackMessage(webhookUrl, buildDigestSummaryBlocks(papers));
    } catch (err) {
      errors.push('Slack digest-summary post failed: ' + err);
    }
    return errors;
  }

  papers.forEach(function(paper) {
    try {
      postSlackMessage(webhookUrl, buildPaperBlocks(paper));
    } catch (err) {
      const message = 'Slack post failed for "' + paper.title + '": ' + err;
      Logger.log('postPapersToSlack: %s', message);
      errors.push(message);
    }
  });

  return errors;
}

/**
 * Convenience function for manual testing from the Apps Script editor:
 * posts one fake paper to Slack so you can confirm SLACK_WEBHOOK_URL and
 * SLACK.enabled are set up correctly WITHOUT running the full pipeline or
 * touching the Sheet. Select postTestMessageToSlack from the function
 * dropdown and click Run, then check the Slack channel.
 */
function postTestMessageToSlack() {
  const webhookUrl = getSlackWebhookUrl();
  if (!webhookUrl) {
    Logger.log(
      'No SLACK_WEBHOOK_URL found in Script Properties. Add it via ' +
      'Project Settings > Script Properties before testing. See the ' +
      'setup steps at the top of postToSlack.gs.'
    );
    return;
  }

  const testPaper = makeNormalizedPaper({
    title: 'Literature Scout Slack Test',
    authors: 'Literature Scout',
    abstract: 'This is a test message confirming the Slack webhook is ' +
      'configured correctly. It was not found by any real source and ' +
      'will not appear in the Digest sheet.',
    link: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
    source: 'test',
    publishedDate: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
  });
  testPaper.matchedTopics = ['test message — ignore'];

  try {
    postSlackMessage(webhookUrl, buildPaperBlocks(testPaper));
    Logger.log('Test message sent — check the Slack channel.');
  } catch (err) {
    Logger.log('Test message failed: %s', err);
  }
}

/**
 * Reads the Slack webhook URL out of Script Properties. Kept as its own
 * function (rather than inlined) so testing / swapping the credential
 * source later doesn't require touching postPapersToSlack().
 *
 * @return {string|null}
 */
function getSlackWebhookUrl() {
  const url = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  return url ? url.trim() : null;
}

/**
 * Sends a single message to Slack via the Incoming Webhook.
 * Throws if Slack responds with anything other than 200/ok, so callers'
 * try/catch blocks can record the failure.
 *
 * @param {string} webhookUrl
 * @param {Object[]} blocks - Slack Block Kit blocks array.
 */
function postSlackMessage(webhookUrl, blocks) {
  const response = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ blocks: blocks }),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code !== 200) {
    throw new Error('Slack returned HTTP ' + code + ': ' + response.getContentText());
  }
}

/**
 * Builds the Block Kit blocks for a single paper's Slack message.
 * One message per paper, formatted so a reader can decide "read this now"
 * vs. "skip" without leaving Slack: title (linked), authors/source/date,
 * matched topics, and an abstract snippet.
 *
 * @param {NormalizedPaper} paper - Must have `matchedTopics` attached.
 * @return {Object[]}
 */
function buildPaperBlocks(paper) {
  const metaLine = [
    paper.source,
    paper.publishedDate,
    paper.authors || 'Authors not listed',
  ].filter(Boolean).join(' · ');

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*<' + paper.link + '|' + slackEscapeLinkText(paper.title) + '>*',
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: slackEscape(metaLine) }],
    },
  ];

  if (paper.matchedTopics && paper.matchedTopics.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '*Matched:* ' + slackEscape(paper.matchedTopics.join(', ')),
      }],
    });
  }

  if (paper.abstract) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: slackEscape(truncateAbstract(paper.abstract)),
      },
    });
  }

  blocks.push({ type: 'divider' });

  return blocks;
}

/**
 * Truncates an abstract to a Slack-friendly length. Keeps individual
 * paper messages scannable, and — together with buildDigestSummaryBlocks'
 * own length handling — keeps every block safely under Slack's
 * 3000-character-per-block limit even for papers with long abstracts.
 *
 * @param {string} abstract
 * @param {number} [maxLength=400]
 * @return {string}
 */
function truncateAbstract(abstract, maxLength) {
  const limit = maxLength || 400;
  const text = String(abstract || '').trim();
  if (text.length <= limit) return text;
  return text.slice(0, limit).trim() + '…';
}

/**
 * Builds a single summary message used when a run produces more new
 * papers than SLACK.maxIndividualPosts — points readers at the Sheet
 * instead of listing every paper inline.
 *
 * @param {NormalizedPaper[]} papers
 * @return {Object[]}
 */
function buildDigestSummaryBlocks(papers) {
  const sheetUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl();

  // Slack rejects any block whose text exceeds 3000 characters
  // (invalid_blocks) — this is what caused the original failure here.
  // A run with many new papers (a first-ever run, or one after a long
  // gap) can easily produce a title list longer than that if every
  // paper is listed inline. Cap the visible list and point to the Sheet
  // for the rest, instead of trying to cram everything in.
  const MAX_LISTED = 20;
  const listedPapers = papers.slice(0, MAX_LISTED);
  const remainingCount = papers.length - listedPapers.length;

  let listText = listedPapers.map(function(paper) {
    return '• <' + paper.link + '|' + slackEscapeLinkText(paper.title) + '> (' + paper.source + ')';
  }).join('\n');

  if (remainingCount > 0) {
    listText += '\n_...and ' + remainingCount + ' more — see the Digest sheet for the full list._';
  }

  // Belt-and-suspenders: even a capped list of 20 could in theory exceed
  // the limit if titles are unusually long, so hard-trim as a last
  // resort rather than ever risking another invalid_blocks failure.
  const SLACK_BLOCK_TEXT_LIMIT = 2900; // buffer under Slack's actual 3000
  if (listText.length > SLACK_BLOCK_TEXT_LIMIT) {
    listText = listText.slice(0, SLACK_BLOCK_TEXT_LIMIT).trim() + '…';
  }

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*' + papers.length + ' new papers* matched your topics in this run — ' +
          'that\'s more than usual, so here\'s one summary instead of ' +
          papers.length + ' separate messages. Full details, including ' +
          'matched topics and abstracts, are in the <' + sheetUrl + '|Digest sheet>.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: listText,
      },
    },
  ];
}

/**
 * Same as slackEscape, but also neutralizes "|" — which has special
 * meaning inside Slack's <url|text> link syntax and would otherwise
 * silently break link rendering (or contribute to invalid_blocks) if a
 * paper's title happens to contain a literal pipe character.
 *
 * @param {string} text
 * @return {string}
 */
function slackEscapeLinkText(text) {
  return slackEscape(text).replace(/\|/g, '❘');
}

/**
 * Escapes Slack mrkdwn's three special characters. Titles/abstracts are
 * external text we don't control, so this prevents a paper whose title
 * happens to contain "&", "<", or ">" from breaking message formatting.
 *
 * @param {string} text
 * @return {string}
 */
function slackEscape(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
