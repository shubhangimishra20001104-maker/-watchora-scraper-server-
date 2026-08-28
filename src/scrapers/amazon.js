/**
 * Scrapes Amazon.in search results for a query using a real headless
 * Chrome page (via the shared Puppeteer browser instance) — this is the
 * server-side equivalent of the "real tab" the Watchora extension used to
 * open in the user's own browser, except it now runs here instead, so the
 * user's browser never needs to open anything.
 *
 * Amazon actively blocks plain HTTP fetches (503 "automated access"
 * response), unlike Flipkart, so this must stay on Puppeteer. Everything
 * below exists to make that as cheap as possible on Render's free-tier
 * CPU/RAM limits:
 *   - one Amazon page is reused across requests instead of opening/closing
 *     a fresh page every search (page creation/teardown has real overhead)
 *   - only one Amazon scrape runs at a time (a simple promise-chain queue)
 *     so concurrent Compare Prices calls can't launch multiple heavy
 *     Chromium navigations simultaneously and exhaust free-tier RAM
 *   - a short in-module cache means a repeated query within the TTL never
 *     touches Puppeteer at all
 *   - navigation/selector/extraction each have their own tight timeout, so
 *     one slow/blocked Amazon request can't hang the whole /compare call
 *     indefinitely — it fails fast with a clean "unavailable" result
 */
const NodeCache = require('node-cache');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const NAVIGATION_TIMEOUT_MS = 12_000;
const SELECTOR_TIMEOUT_MS = 6_000;
const EXTRACTION_TIMEOUT_MS = 4_000;
const RESULT_CACHE_TTL_SECONDS = 5 * 60;

const resultCache = new NodeCache({ stdTTL: RESULT_CACHE_TTL_SECONDS });

// One shared Amazon page + a promise-chain "queue" so only one Amazon scrape
// ever runs at a time, regardless of how many /compare requests arrive
// concurrently — this is the single biggest lever against Render free-tier
// RAM exhaustion, since each concurrent Chromium navigation is expensive.
let sharedPagePromise = null;
let queueTail = Promise.resolve();

async function getSharedPage(browser) {
  if (sharedPagePromise) {
    const existing = await sharedPagePromise;
    if (!existing.isClosed()) {
      return existing;
    }
    sharedPagePromise = null;
  }

  sharedPagePromise = (async () => {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1366, height: 900 });

    // Block everything except the bare document/script/xhr traffic needed to
    // render the search-result DOM: images, fonts, stylesheets, media, and
    // known analytics/tracking hosts are pure overhead for a page we only
    // ever read text out of.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      const url = req.url();
      const isTracking = /doubleclick|google-analytics|googletagmanager|fls-na\.amazon|amazon-adsystem/.test(
        url,
      );
      if (type === 'image' || type === 'stylesheet' || type === 'font' || type === 'media' || isTracking) {
        req.abort().catch(() => null);
      } else {
        req.continue().catch(() => null);
      }
    });

    return page;
  })();

  return sharedPagePromise;
}

/** Runs `fn` after every previously queued Amazon job has finished, so at
 * most one Amazon Puppeteer job is ever in flight — extra concurrent
 * requests wait in line instead of spawning parallel navigations. */
function enqueue(fn) {
  const run = queueTail.then(fn, fn);
  // Swallow rejections here so one failed job doesn't poison the queue for
  // everything queued after it; the caller still sees the real error via
  // the returned `run` promise.
  queueTail = run.catch(() => null);
  return run;
}

async function scrapeAmazonUncached(browser, query) {
  const log = {
    query,
    browserReuse: true,
    pageReuse: Boolean(sharedPagePromise),
    navigationTimeMs: null,
    selectorWaitTimeMs: null,
    extractionTimeMs: null,
    totalTimeMs: null,
    resultCount: 0,
    cacheHit: false,
    failureReason: null,
  };
  const overallStart = Date.now();

  let page;
  try {
    page = await getSharedPage(browser);
  } catch (error) {
    // Losing the shared page (e.g. browser died) means we can't reuse
    // anything this round — reset state so the next request gets a clean
    // page instead of repeatedly failing against a dead reference.
    sharedPagePromise = null;
    log.pageReuse = false;
    log.failureReason = `page-acquire-failed: ${error.message}`;
    log.totalTimeMs = Date.now() - overallStart;
    console.error('[amazon]', log);
    throw error;
  }

  try {
    const url = `https://www.amazon.in/s?k=${encodeURIComponent(query)}`;

    const navStart = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    log.navigationTimeMs = Date.now() - navStart;

    // Detect Amazon's bot-check/CAPTCHA interstitial explicitly rather than
    // just letting selector-wait time out silently — this gives an honest
    // "temporarily unavailable" instead of quietly retrying against a page
    // that will never contain real results.
    const isBlocked = await page
      .evaluate(() => {
        const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
        return (
          bodyText.includes('enter the characters you see below') ||
          bodyText.includes('automated access') ||
          Boolean(document.querySelector('form[action*="validateCaptcha"]'))
        );
      })
      .catch(() => false);
    if (isBlocked) {
      log.failureReason = 'bot-check-detected';
      log.totalTimeMs = Date.now() - overallStart;
      console.warn('[amazon]', log);
      return [];
    }

    const selectorStart = Date.now();
    const found = await page
      .waitForSelector('div[data-component-type="s-search-result"]', {
        timeout: SELECTOR_TIMEOUT_MS,
      })
      .then(() => true)
      .catch(() => false);
    log.selectorWaitTimeMs = Date.now() - selectorStart;

    if (!found) {
      log.failureReason = 'selector-timeout';
      log.totalTimeMs = Date.now() - overallStart;
      console.warn('[amazon]', log);
      return [];
    }

    const extractionStart = Date.now();
    const candidates = await Promise.race([
      page.evaluate(() => {
        // Scan more of the first results page (not just the first 8 cards)
        // before giving up — Amazon interleaves sponsored/related items
        // (other brands, accessories) among genuine matches, so the actual
        // "iPhone 16" card can easily be past position 8 even though it's
        // clearly present somewhere on the page.
        const cards = Array.from(
          document.querySelectorAll('div[data-component-type="s-search-result"]'),
        ).slice(0, 48);

        return cards
          .map((card) => {
            // Amazon's <h2> right under the image only holds the brand name
            // (e.g. "OnePlus"); the real full title lives in a second
            // <h2 aria-label="..."> just below it (inside the title link), but
            // that aria-label text itself omits the brand — so combine both:
            // brand prefix + full title, so brand-name query words (e.g. a
            // search for "OnePlus N6") still match against the title.
            const titleH2 = card.querySelector('a[href*="/dp/"] h2[aria-label], h2[aria-label]');
            const h2Fallback = card.querySelector('h2 span, h2 a span');
            const priceEl = card.querySelector('span.a-price > span.a-offscreen');
            const linkEl = card.querySelector('a[href*="/dp/"]');
            const ratingEl = card.querySelector('span.a-icon-alt');

            const brandText = h2Fallback ? h2Fallback.textContent.trim() : null;
            const ariaTitle = titleH2 ? titleH2.getAttribute('aria-label') : null;
            const title =
              brandText && ariaTitle && !ariaTitle.toLowerCase().startsWith(brandText.toLowerCase())
                ? `${brandText} ${ariaTitle}`
                : ariaTitle || brandText;
            const priceText = priceEl ? priceEl.textContent.trim() : null;
            const href = linkEl ? linkEl.getAttribute('href') : null;
            const rating = ratingEl ? ratingEl.textContent.trim() : null;

            return { title, priceText, href, rating };
          })
          .filter((c) => c.title && c.priceText);
      }),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('extraction-timeout')), EXTRACTION_TIMEOUT_MS),
      ),
    ]);
    log.extractionTimeMs = Date.now() - extractionStart;

    const results = candidates.map((c) => ({
      title: c.title,
      priceText: c.priceText,
      url: c.href ? new URL(c.href, 'https://www.amazon.in').toString() : url,
      rating: c.rating,
    }));

    log.resultCount = results.length;
    log.totalTimeMs = Date.now() - overallStart;
    console.log('[amazon]', log);
    return results;
  } catch (error) {
    log.failureReason = error.message;
    log.totalTimeMs = Date.now() - overallStart;
    console.error('[amazon]', log);
    // A page-level crash (navigation failure, detached frame, etc.) likely
    // means the shared page itself is now unusable — drop the reference so
    // the next request creates a fresh one instead of repeatedly failing.
    sharedPagePromise = null;
    return [];
  }
  // Deliberately not closing the page in a `finally` here — it's reused
  // across requests. Cleanup of stray listeners happens once, at page
  // creation (`getSharedPage`), not per-request.
}

async function scrapeAmazon(browser, query) {
  const cacheKey = query.toLowerCase();
  const cached = resultCache.get(cacheKey);
  if (cached) {
    console.log('[amazon]', { query, cacheHit: true, resultCount: cached.length });
    return cached;
  }

  const results = await enqueue(() => scrapeAmazonUncached(browser, query));

  // Only cache genuine outcomes (including "found nothing"), never a
  // request that blew its timeout/crashed — those are transient and
  // shouldn't keep serving a stale failure for the next 5 minutesss.
  resultCache.set(cacheKey, results);
  return results;
}

module.exports = { scrapeAmazon };
