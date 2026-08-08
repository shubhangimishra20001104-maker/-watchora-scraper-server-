/**
 * Scrapes Croma's search results for a query — same real-headless-Chrome
 * approach as `amazon.js`; see that file's doc comment for the overall
 * rationale (this replaces the tab the extension used to open per-site).
 */
async function scrapeCroma(browser, query) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    );
    await page.setViewport({ width: 1366, height: 900 });

    const url = `https://www.croma.com/searchB?q=${encodeURIComponent(query)}%3Arelevance`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });

    await page.waitForSelector('.cp-product', { timeout: 10_000 }).catch(() => null);

    const candidates = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.cp-product')).slice(0, 48);

      return cards
        .map((card) => {
          const titleEl = card.querySelector('h3.product-title a, .product-title a');
          const priceEl = card.querySelector('.plp-srp-new-amount, .new-price .amount');
          const linkEl = card.querySelector('a[href*="/p/"]');

          const title = titleEl ? titleEl.textContent.trim() : null;
          const priceText = priceEl ? priceEl.textContent.trim() : null;
          const href = linkEl ? linkEl.getAttribute('href') : null;

          return { title, priceText, href };
        })
        .filter((c) => c.title && c.priceText);
    });

    return candidates.map((c) => ({
      title: c.title,
      priceText: c.priceText,
      url: c.href ? new URL(c.href, 'https://www.croma.com').toString() : url,
      rating: null,
    }));
  } finally {
    await page.close();
  }
}

module.exports = { scrapeCroma };
