/**
 * Scrapes Flipkart search results for a query — same real-headless-Chrome
 * approach as `amazon.js`; see that file's doc comment for the overall
 * rationale (this replaces the tab the extension used to open per-site).
 */
async function scrapeFlipkart(browser, query) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    );
    await page.setViewport({ width: 1366, height: 900 });

    const url = `https://www.flipkart.com/search?q=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });

    // Flipkart shows a login modal on nearly every fresh session; dismiss it
    // so it doesn't obscure/interfere with the result grid underneath.
    await page
      .evaluate(() => {
        const closeBtn = Array.from(document.querySelectorAll('button')).find(
          (b) => b.textContent.trim() === '✕',
        );
        if (closeBtn) closeBtn.click();
      })
      .catch(() => null);

    await page.waitForSelector('a[href*="/p/"]', { timeout: 10_000 }).catch(() => null);

    const candidates = await page.evaluate(() => {
      // Flipkart's markup varies a lot between product categories (its
      // grid-view vs list-view layouts use different class names), so
      // instead of one fixed card selector we group every product-detail
      // link ("/p/") by its ancestor 3 levels up and treat each unique
      // ancestor as one card — a simplified version of the "repeated
      // sibling" grouping the extension's own scanner used.
      const links = Array.from(document.querySelectorAll('a[href*="/p/"]')).slice(0, 80);
      const seen = new Set();
      const cards = [];

      for (const link of links) {
        let ancestor = link;
        for (let i = 0; i < 3 && ancestor.parentElement; i += 1) {
          ancestor = ancestor.parentElement;
        }
        if (seen.has(ancestor)) continue;
        seen.add(ancestor);

        const text = ancestor.textContent || '';
        const priceMatch = text.match(/₹[\d,]+/);
        if (!priceMatch) continue;

        // Prefer a real title-bearing anchor's `title` attribute (Flipkart
        // sets this reliably on the actual product-name link) — falling
        // back to this specific link's own attributes/text only when
        // nothing better is found in the card, since a bare textContent
        // grab off the wrong link can accidentally include "Add to
        // Compare", ratings, and price text glued together with no
        // separators.
        const titledLink = ancestor.querySelector('a[title]');
        let title = (
          (titledLink && titledLink.getAttribute('title')) ||
          link.getAttribute('title') ||
          link.textContent ||
          ''
        ).trim();
        // Flipkart's card ancestor often has no dedicated title element, so
        // the fallback above grabs the whole card's mashed-together text
        // (ratings, specs, price, "Add to Compare") with no separators —
        // trim it down to just the product name portion for a readable
        // result: strip the "Add to Compare" prefix and cut everything
        // from the first digit-ratings-count run onward.
        // Flipkart prepends badges like "Bestseller" and/or "Add to
        // Compare" directly onto the title text with no separator — strip
        // any run of these known prefixes (in any order/repetition).
        let prevTitle;
        do {
          prevTitle = title;
          title = title.replace(/^(Bestseller|Add to Compare)/i, '');
        } while (title !== prevTitle);
        // Cut off at the first sign of the rating block (a decimal rating
        // like "4.6" immediately followed by a comma-grouped count and
        // "Ratings"/"Reviews", or a bare "128 GB ROM" spec run) — whichever
        // comes first — so only the actual product name remains.
        const specsCutoff = title.search(/\d\.\d[\d,]*\s*(Ratings|Reviews)|\d+\s*GB ROM/i);
        if (specsCutoff > 0) {
          title = title.slice(0, specsCutoff);
        }
        title = title.trim();
        if (!title) continue;

        cards.push({
          title,
          priceText: priceMatch[0],
          href: link.getAttribute('href'),
        });
      }
      return cards.slice(0, 48);
    });

    return candidates.map((c) => ({
      title: c.title,
      priceText: c.priceText,
      url: c.href ? new URL(c.href, 'https://www.flipkart.com').toString() : url,
      rating: null,
    }));
  } finally {
    await page.close();
  }
}

module.exports = { scrapeFlipkart };
