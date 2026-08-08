/**
 * Scrapes Amazon.in search results for a query using a real headless
 * Chrome page (via the shared Puppeteer browser instance) — this is the
 * server-side equivalent of the "real tab" the Watchora extension used to
 * open in the user's own browser, except it now runs here instead, so the
 * user's browser never needs to open anything.
 */
async function scrapeAmazon(browser, query) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    );
    await page.setViewport({ width: 1366, height: 900 });

    const url = `https://www.amazon.in/s?k=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });

    // Amazon's search result cards share this data-component-type attribute
    // regardless of category — much more stable than relying on class names,
    // which Amazon changes frequently between deployments.
    await page.waitForSelector('div[data-component-type="s-search-result"]', {
      timeout: 10_000,
    }).catch(() => null);

    const candidates = await page.evaluate(() => {
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
    });

    return candidates.map((c) => ({
      title: c.title,
      priceText: c.priceText,
      url: c.href ? new URL(c.href, 'https://www.amazon.in').toString() : url,
      rating: c.rating,
    }));
  } finally {
    await page.close();
  }
}

module.exports = { scrapeAmazon };
