/**
 * Scrapes JioMart's search results for a query — same real-headless-Chrome
 * approach as `amazon.js`; see that file's doc comment for the overall
 * rationale.
 *
 * NOTE: JioMart's `/search/<query>` URL 404s for a fresh headless session
 * (it appears to require an already-established location/session cookie
 * before that route resolves). The `/products?q=<query>` route works
 * directly without any of that — discovered by simulating a real user
 * typing into the homepage search box and observing where it navigated.
 */
async function scrapeJiomart(browser, query) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    );
    await page.setViewport({ width: 1366, height: 900 });

    const url = `https://www.jiomart.com/products?q=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });

    await page.waitForSelector('.productCard__productTitle', { timeout: 10_000 }).catch(() => null);

    const candidates = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.productContainer')).slice(0, 48);

      return cards
        .map((card) => {
          const titleEl = card.querySelector('.productCard__productTitle');
          const priceEl = card.querySelector('.PriceContainer__currentPrice');
          const slug = card.getAttribute('data-product-slug');

          const title = titleEl ? titleEl.textContent.trim() : null;
          const priceText = priceEl ? priceEl.textContent.trim() : null;

          return { title, priceText, slug };
        })
        .filter((c) => c.title && c.priceText);
    });

    return candidates.map((c) => ({
      title: c.title,
      priceText: c.priceText,
      url: c.slug ? `https://www.jiomart.com/p/${c.slug}` : url,
      rating: null,
    }));
  } finally {
    await page.close();
  }
}

module.exports = { scrapeJiomart };
