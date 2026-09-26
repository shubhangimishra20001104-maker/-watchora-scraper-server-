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
const { scrapeRelianceDigital } = require('./scrapers/reliance-digital');
const { scoreMatch } = require('./matcher');

const PORT = process.env.PORT || 3000;
const CACHE_TTL_SECONDS = 5 * 60;
const MINIMUM_USABLE_CONFIDENCE = 35;

const cache = new NodeCache({ stdTTL: CACHE_TTL_SECONDS });
const app = express();
app.use(cors());

// Free-tier hosting (e.g. Render's 512MB plan) has proven too memory-
// constrained to reliably scrape more than a couple of sites per request —
// it kept crashing (OOM, 502/503s) even with batching. Scaled back down to
// just these sites, run in parallel, which is small enough to stay stable
// on the free tier. Reliance Digital was added despite this constraint
// because — unlike Amazon/Flipkart's Puppeteer paths — it resolves in well
// under a second (no bot-check delay), so it adds negligible extra
// Chromium page/RAM load per request; if that stops being true (site
// changes, gets bot-checked, etc.) reconsider dropping it back out per
// this same free-tier RAM reasoning.
const siteJobs = [
  ['amazon', 'Amazon', scrapeAmazon],
  ['flipkart', 'Flipkart', scrapeFlipkart],
  ['reliance-digital', 'Reliance Digital', scrapeRelianceDigital],
];
const siteJobsIds = siteJobs.map(([siteId]) => siteId);

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

  const results = await Promise.all(
    siteJobs.map(([siteId, siteName, scraperFn]) => searchSite(siteId, siteName, scraperFn, query)),
  );

  // Only cache results that actually completed a scrape (a real price or a
  // genuine "no matching product" outcome). Don't cache "Unavailable"
  // failures — those are transient (timeouts, crashes, etc.), and caching
  // them for 5 minutes would keep serving a stale failure to every
  // subsequent search for the same query instead of letting it retry.
  const isTransientFailure = (result) =>
    result.error === 'Unavailable — could not retrieve the latest price. Try again later.';
  if (!results.some(isTransientFailure)) {
    cache.set(cacheKey, results);
  }
  res.json({ query, results, cached: false });
});

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    // RENDER_GIT_COMMIT is auto-populated by Render for every deploy — a
    // quick, unambiguous way to confirm exactly which commit is actually
    // live, without relying on dashboard screenshots/logs (which proved
    // easy to mix up with the wrong deploy/tab during troubleshooting).
    gitCommit: process.env.RENDER_GIT_COMMIT || 'unknown',
    sites: siteJobsIds,
  }),
);

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
