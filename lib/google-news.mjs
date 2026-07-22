import { XMLParser } from 'fast-xml-parser';
import crypto from 'node:crypto';

// Broad enough to catch trade coverage (TCTMD, Cardiovascular Business,
// Medscape Cardiology, STS/AATS releases, etc.) without drowning in noise.
// Edit this string directly to widen or narrow what counts as "News".
const NEWS_QUERY =
  '(cardiac surgery OR CABG OR TAVR OR "aortic dissection" OR ECMO OR "valve surgery" OR "structural heart")';

// Returns an array of { title, source, url, publishedDate, summary }
export async function fetchCardiacNews({ days = 2, limit = 10 } = {}) {
  const q = encodeURIComponent(`${NEWS_QUERY} when:${days}d`);
  const feedUrl = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;

  const res = await fetch(feedUrl);
  if (!res.ok) throw new Error(`Google News RSS failed: ${res.status}`);
  const xml = await res.text();

  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(xml);

  let items = parsed?.rss?.channel?.item ?? [];
  if (!Array.isArray(items)) items = [items];

  return items
    .slice(0, limit)
    .map(parseItem)
    .filter(Boolean);
}

function parseItem(item) {
  try {
    const rawTitle = String(item.title ?? '').trim();
    const url = String(item.link ?? '').trim();
    if (!rawTitle || !url) return null;

    // Google News formats titles as "Headline - Outlet Name"
    const splitAt = rawTitle.lastIndexOf(' - ');
    const title = splitAt > -1 ? rawTitle.slice(0, splitAt) : rawTitle;
    const source =
      (splitAt > -1 ? rawTitle.slice(splitAt + 3) : null) ||
      item.source?.['#text'] ||
      'News';

    const publishedDate = item.pubDate
      ? new Date(item.pubDate).toISOString().slice(0, 10)
      : null;

    // Stable dedup key since news URLs have no PMID equivalent.
    const externalId = 'news_' + crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);

    return { externalId, title, source, url, publishedDate, rawSnippet: rawTitle };
  } catch {
    return null;
  }
}
