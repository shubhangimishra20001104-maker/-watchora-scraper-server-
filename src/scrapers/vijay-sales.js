/**
 * Scrapes Vijay Sales's search results for a query — same real-headless-
 * Chrome approach as `amazon.js`; see that file's doc comment for the
 * overall rationale.
 */
async function scrapeVijaySales(browser, query) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    );
    await page.setViewport({ width: 1366, height: 900 });

    const url = `https://www.vijaysales.com/search?q=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });

    await page.waitForSelector('.productcollection__item', { timeout: 10_000 }).catch(() => null);

    const candidates = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('a.productcollection__item')).slice(0, 48);

      return cards
        .map((card) => {
          const titleEl = card.querySelector('.productcollection__item-title');
          // Some cards show a "From X To Y" range price rather than a
          // single value — the matcher/UI just needs a single number, so
          // the price parser downstream picks the first amount it finds.
          const priceEl = card.querySelector('.price span');

          const title = titleEl ? titleEl.textContent.trim() : card.getAttribute('title');
          const priceText = priceEl ? priceEl.textContent.trim() : null;
          const href = card.getAttribute('href');

          return { title, priceText, href };
        })
        .filter((c) => c.title && c.priceText);
    });

    return candidates.map((c) => ({
      title: c.title,
      priceText: c.priceText,
      url: c.href ? new URL(c.href, 'https://www.vijaysales.com').toString() : url,
      rating: null,
    }));
  } finally {
    await page.close();
  }
}

module.exports = { scrapeVijaySales };
