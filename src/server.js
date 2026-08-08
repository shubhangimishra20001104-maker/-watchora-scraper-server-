/**
 * Watchora Scraper Server — a minimal, standalone Node/Express service that
 * runs headless Chrome (via Puppeteer) to search Amazon.in and Flipkart on
 * the extension's behalf, so the user's own browser never has to open a
 * tab. This is the validation prototype for 2 sites, described in the
 * extension's Compare Prices redesign conversation: if this proves
 * reliable, the same pattern extends to the remaining 7 retailers.
 *
 * ONE browser instance is launched at startup and reused across requests
 * (opening a fresh `page` per request, closing it when done) — launching a
 * whole new Chromium process per search would be far too slow for a
 * user-facing "Compare Prices" click.
 *
 * Results are cached in-memory for a few minutes per query so repeated
 * searches (or a user re-opening Compare Prices) don't hit Amazon/Flipkart
 * again immediately — reduces both latency and bot-detection risk.
 */
const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');
const puppeteer = require('puppeteer');

const { scrapeAmazon } = require('./scrapers/amazon');
const { scrapeFlipkart } = require('./scrapers/flipkart');
const { scrapeCroma } = require('./scrapers/croma');
const { scrapeVijaySales } = require('./scrapers/vijay-sales');
const { scrapeSnapdeal } = require('./scrapers/snapdeal');
const { scrapeJiomart } = require('./scrapers/jiomart');
const { scoreMatch } = require('./matcher');

const PORT = process.env.PORT || 3000;
const CACHE_TTL_SECONDS = 5 * 60;
const MINIMUM_USABLE_CONFIDENCE = 35;

const cache = new NodeCache({ stdTTL: CACHE_TTL_SECONDS });
const app = express();
app.use(cors());

let browserPromise = null;
async function getBrowser() {
  if (browserPromise) {
    // The shared browser can crash or be killed by the OS between requests;
    // reusing a dead instance would make every future request fail with
    // "Connection closed." forever, so verify it's still alive before reuse.
    const existing = await browserPromise;
    if (existing.connected) {
      return existing;
    }
    browserPromise = null;
  }

  browserPromise = puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  return browserPromise;
}

/** Runs one site's scraper, scores every candidate against the query, and
 * returns the single best match (or a null/"not found" result) — mirrors
 * the shape the extension's `PriceComparisonResult` expects, so the
 * extension side only needs to swap its data source, not its rendering. */
async function searchSite(siteId, siteName, scraperFn, query) {
  try {
    const browser = await getBrowser();
    const candidates = await scraperFn(browser, query);

    let best = null;
    for (const candidate of candidates) {
      const confidence = scoreMatch(query, candidate.title);
      if (!best || confidence > best.confidence) {
        best = { candidate, confidence };
      }
    }

    if (!best || best.confidence < MINIMUM_USABLE_CONFIDENCE) {
      return {
        siteId,
        site: siteName,
        price: null,
        productTitle: null,
        url: null,
        matchConfidence: null,
        error: 'No matching product found for this search.',
      };
    }

    const priceMatch = best.candidate.priceText.match(/[\d,]+/);
    const price = priceMatch ? Number(priceMatch[0].replace(/,/g, '')) : null;

    return {
      siteId,
      site: siteName,
      price,
      productTitle: best.candidate.title,
      url: best.candidate.url,
      matchConfidence: best.confidence,
      error: price === null ? 'No matching product found for this search.' : null,
    };
  } catch (error) {
    console.error(`[${siteId}] scrape failed:`, error.message);
    return {
      siteId,
      site: siteName,
      price: null,
      productTitle: null,
      url: null,
      matchConfidence: null,
      error: 'Unavailable — could not retrieve the latest price. Try again later.',
    };
  }
}

app.get('/compare', async (req, res) => {
  const query = (req.query.q || '').toString().trim();
  if (!query) {
    return res.status(400).json({ error: 'Missing required "q" query parameter.' });
  }

  const cacheKey = query.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json({ query, results: cached, cached: true });
  }

  // Free-tier hosting (e.g. Render's 512MB plan + a proxy-level response
  // timeout around 100s) can't handle either extreme: 6 parallel Chromium
  // pages exceeds the memory ceiling, while fully sequential scraping of
  // 6 sites can take longer than the proxy will wait, causing a 502 even
  // though the server itself is still working fine. Batches of 2 at a
  // time is a middle ground — low enough peak memory to avoid an OOM
  // crash, fast enough (3 batches) to finish before the proxy gives up.
  const siteJobs = [
    ['amazon', 'Amazon', scrapeAmazon],
    ['flipkart', 'Flipkart', scrapeFlipkart],
    ['croma', 'Croma', scrapeCroma],
    ['vijay-sales', 'Vijay Sales', scrapeVijaySales],
    ['snapdeal', 'Snapdeal', scrapeSnapdeal],
    ['jiomart', 'JioMart', scrapeJiomart],
  ];
  const BATCH_SIZE = 2;

  const results = [];
  for (let i = 0; i < siteJobs.length; i += BATCH_SIZE) {
    const batch = siteJobs.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(([siteId, siteName, scraperFn]) => searchSite(siteId, siteName, scraperFn, query)),
    );
    results.push(...batchResults);
  }

  cache.set(cacheKey, results);
  res.json({ query, results, cached: false });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Watchora scraper server listening on http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  process.exit(0);
});
