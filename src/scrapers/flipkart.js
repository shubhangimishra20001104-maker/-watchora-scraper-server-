/**
 * Scrapes Flipkart search results for a query. Flipkart's search page is
 * fully server-rendered (unlike Amazon, which returns a 503 "automated
 * access" block to plain HTTP requests) — a bare `fetch()` + Cheerio parse
 * gets the exact same product data a real browser would see, without the
 * cost of launching Chromium at all. This is dramatically faster than the
 * Puppeteer path (typically well under a second vs several seconds), so
 * it's tried first; `scrapeFlipkartViaPuppeteer` (see flipkart-puppeteer.js)
 * is only used as a fallback if this fetch path returns zero usable
 * candidates (e.g. Flipkart starts bot-checking plain requests, or changes
 * its markup in a way this parser can't handle).
 */
const cheerio = require('cheerio');
const { scrapeFlipkartViaPuppeteer } = require('./flipkart-puppeteer');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchFlipkartCandidates(query) {
  const url = `https://www.flipkart.com/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-IN,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];

  const html = await res.text();
  const $ = cheerio.load(html);

  // Same "group product links by a shared ancestor card" approach as the
  // Puppeteer version, since Flipkart's markup varies between category
  // layouts — see flipkart-puppeteer.js for the fuller rationale.
  const links = $('a[href*="/p/"]').slice(0, 80);
  const seen = new Set();
  const candidates = [];

  links.each((_i, el) => {
    const $link = $(el);
    let ancestor = $link;
    for (let i = 0; i < 3; i += 1) {
      const parent = ancestor.parent();
      if (parent.length === 0) break;
      ancestor = parent;
    }

    // dedupe by the ancestor's own position in the DOM (data-id is present
    // on most card wrappers; fall back to the raw href when it's missing)
    const dedupeKey = ancestor.attr('data-id') || $link.attr('href');
    if (!dedupeKey || seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const text = ancestor.text() || '';
    const priceMatch = text.match(/₹[\d,]+/);
    if (!priceMatch) return;

    // The product thumbnail's alt text is a clean, pre-formatted product
    // name on Flipkart's search results ("Apple iPhone 16 (White, 128
    // GB)") — much more reliable than trying to isolate the title out of
    // the card's mashed-together text like the Puppeteer fallback has to.
    const imgAlt = ancestor.find('img[alt]').first().attr('alt');
    const titledLink = ancestor.find('a[title]').first().attr('title');
    const title = (imgAlt || titledLink || $link.text() || '').trim();
    if (!title) return;

    const href = $link.attr('href');
    candidates.push({
      title,
      priceText: priceMatch[0],
      url: href ? new URL(href, 'https://www.flipkart.com').toString() : url,
      rating: null,
    });
  });

  return candidates.slice(0, 48);
}

async function scrapeFlipkart(browser, query) {
  try {
    const candidates = await fetchFlipkartCandidates(query);
    if (candidates.length > 0) {
      return candidates;
    }
  } catch (error) {
    console.error('[flipkart] fast fetch path failed, falling back to Puppeteer:', error.message);
  }

  return scrapeFlipkartViaPuppeteer(browser, query);
}

module.exports = { scrapeFlipkart };
