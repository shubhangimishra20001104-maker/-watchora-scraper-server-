/**
 * Scrapes Reliance Digital's search results using a real headless Chrome
 * page (via the shared Puppeteer browser instance). Reliance Digital's
 * search results are populated client-side after the page's JS runs (a
 * plain `fetch()` of the search URL only ever returns a static "page not
 * found" shell — confirmed while building this scraper), so — unlike
 * Flipkart — it can't use the fast Cheerio path and must stay on Puppeteer.
 *
 * Good news found while building this: unlike Amazon, Reliance Digital
 * does NOT appear to bot-check plain headless-browser requests — a search
 * page's product cards are already in the DOM well under 2 seconds after
 * `domcontentloaded`, so this scraper stays fast despite needing a real
 * browser. Mirrors amazon.js's shared-page + single-flight-queue pattern
 * so this doesn't add its own extra concurrent Chromium navigation on top
 * of Amazon's (see server.js's comment on free-tier RAM limits).
 */
const NodeCache = require('node-cache');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const NAVIGATION_TIMEOUT_MS = 10_000;
const SELECTOR_TIMEOUT_MS = 6_000;
const EXTRACTION_TIMEOUT_MS = 4_000;
const RESULT_CACHE_TTL_SECONDS = 5 * 60;

const resultCache = new NodeCache({ stdTTL: RESULT_CACHE_TTL_SECONDS });

// Same one-page-reused + promise-chain-queue approach as amazon.js — see
// that file's comment for why (free-tier RAM is the binding constraint,
// not CPU speed, so avoiding concurrent Chromium navigations matters more
// than raw per-request latency).
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

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      const url = req.url();
      const isTracking = /doubleclick|google-analytics|googletagmanager|clevertap|moengage/.test(url);
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

function enqueue(fn) {
  const run = queueTail.then(fn, fn);
  queueTail = run.catch(() => null);
  return run;
}

async function scrapeRelianceDigitalUncached(browser, query) {
  const log = {
    query,
    pageReuse: Boolean(sharedPagePromise),
    navigationTimeMs: null,
    selectorWaitTimeMs: null,
    extractionTimeMs: null,
    totalTimeMs: null,
    resultCount: 0,
    failureReason: null,
  };
  const overallStart = Date.now();

  let page;
  try {
    page = await getSharedPage(browser);
  } catch (error) {
    sharedPagePromise = null;
    log.failureReason = `page-acquire-failed: ${error.message}`;
    log.totalTimeMs = Date.now() - overallStart;
    console.error('[reliance-digital]', log);
    throw error;
  }

  try {
    // This is the URL a real search-box submission actually navigates to
    // (found by driving a real page interaction) — a guessed `/search?q=`
    // path returns a static 404 shell, even to a real browser.
    const url = `https://www.reliancedigital.in/products?q=${encodeURIComponent(query)}&page_no=1&page_size=12&page_type=number`;

    const navStart = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    log.navigationTimeMs = Date.now() - navStart;

    const selectorStart = Date.now();
    const found = await page
      .waitForSelector('.product-card', { timeout: SELECTOR_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    log.selectorWaitTimeMs = Date.now() - selectorStart;

    if (!found) {
      log.failureReason = 'selector-timeout';
      log.totalTimeMs = Date.now() - overallStart;
      console.warn('[reliance-digital]', log);
      return [];
    }

    const extractionStart = Date.now();
    const candidates = await Promise.race([
      page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.product-card')).slice(0, 48);
        return cards
          .map((card) => {
            const titleEl = card.querySelector('.product-card-title');
            const priceEl = card.querySelector('.price');
            const linkEl = card.querySelector('a.product-card-image');
            return {
              title: titleEl ? titleEl.textContent.trim() : null,
              priceText: priceEl ? priceEl.textContent.trim() : null,
              href: linkEl ? linkEl.getAttribute('href') : null,
            };
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
      url: c.href ? new URL(c.href, 'https://www.reliancedigital.in').toString() : url,
      rating: null,
    }));

    log.resultCount = results.length;
    log.totalTimeMs = Date.now() - overallStart;
    console.log('[reliance-digital]', log);
    return results;
  } catch (error) {
    log.failureReason = error.message;
    log.totalTimeMs = Date.now() - overallStart;
    console.error('[reliance-digital]', log);
    sharedPagePromise = null;
    return [];
  }
}

async function scrapeRelianceDigital(browser, query) {
  const cacheKey = query.toLowerCase();
  const cached = resultCache.get(cacheKey);
  if (cached) {
    console.log('[reliance-digital]', { query, cacheHit: true, resultCount: cached.length });
    return cached;
  }

  const results = await enqueue(() => scrapeRelianceDigitalUncached(browser, query));
  resultCache.set(cacheKey, results);
  return results;
}

module.exports = { scrapeRelianceDigital };
