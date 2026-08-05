import { createClient } from '@supabase/supabase-js';
import { searchPubmed, CATEGORY_QUERIES } from '../lib/pubmed.mjs';
import { fetchCardiacNews } from '../lib/google-news.mjs';
import { batchSummarize } from '../lib/summarize.mjs';

const MAX_FUTURE_DAYS = 3;

// Some journals set PubMed's electronic pub date weeks/months ahead of the
// actual print issue. Uncapped, those items sort to the top of the feed
// forever. Clamp anything too far in the future back to today.
function normalizePublishedDate(dateStr) {
  if (!dateStr) return dateStr;
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return dateStr; // malformed date — leave as-is, don't crash ingestion

  const maxAllowed = new Date();
  maxAllowed.setDate(maxAllowed.getDate() + MAX_FUTURE_DAYS);

  if (parsed > maxAllowed) {
    return new Date().toISOString();
  }
  return dateStr;
}

const VALID_CATEGORIES = ['coronary', 'valvular', 'structural', 'aortic', 'mcs', 'news', 'journals'];

// ECMO was renamed to MCS when the query terms were expanded to cover LVAD,
// Impella, TandemHeart, cardiogenic shock, etc. Keep the old slug working so
// a stale cron URL or bookmarked endpoint doesn't silently 400.
const CATEGORY_ALIASES = { ecmo: 'mcs' };

// Per-category fetch windows. Journals is a whole-TOC sweep so it needs a
// bigger cap; topic queries are narrower.
const FETCH_CONFIG = {
  journals: { days: 14, retmax: 90 },
  news:     { days: 3, limit: 20 },
  default:  { days: 7, retmax: 25 },
};

export default async function handler(req, res) {
  // Vercel signs cron-triggered requests with this header automatically.
  // Rejects anyone hitting the URL directly without the secret.
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const rawCategory = req.query.category;
  const category = CATEGORY_ALIASES[rawCategory] || rawCategory;
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Unknown category: ${rawCategory}` });
  }

  let supabase;

  try {
    // Validate env vars up front with clear errors, since a malformed
    // SUPABASE_URL throws inside createClient() and previously crashed
    // silently before reaching the catch block below.
    if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is not set');
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');

    let parsedUrl;
    try {
      parsedUrl = new URL(process.env.SUPABASE_URL);
    } catch {
      throw new Error(`SUPABASE_URL is not a valid URL: "${process.env.SUPABASE_URL}"`);
    }
    if (parsedUrl.pathname !== '/' && parsedUrl.pathname !== '') {
      throw new Error(
        `SUPABASE_URL should be just the bare domain (e.g. https://xxxxx.supabase.co), ` +
        `but it has a path attached: "${parsedUrl.pathname}". Remove everything after ".co".`
      );
    }

    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // 1. Fetch candidates from the right source.
    let candidates;
    if (category === 'news') {
      const cfg = FETCH_CONFIG.news;
      const items = await fetchCardiacNews({ days: cfg.days, limit: cfg.limit });
      candidates = items.map((it) => ({
        id: it.externalId,
        externalId: it.externalId,
        title: it.title,
        source: it.source,
        url: it.url,
        publishedDate: normalizePublishedDate(it.publishedDate),
        rawSnippet: it.rawSnippet,
      }));
    } else {
      const cfg = FETCH_CONFIG[category] || FETCH_CONFIG.default;

      // A missing query used to fall through to searchPubmed(undefined), which
      // returned zero results and exited with a 200. That made a broken
      // category indistinguishable from a quiet day. Fail loudly instead.
      const query = CATEGORY_QUERIES[category];
      if (!query) {
        throw new Error(
          `No PubMed query defined for category "${category}". ` +
          `Available keys in CATEGORY_QUERIES: ${Object.keys(CATEGORY_QUERIES).join(', ')}`
        );
      }

      const articles = await searchPubmed(query, { days: cfg.days, retmax: cfg.retmax });
      candidates = articles.map((a) => ({
        id: a.pmid,
        externalId: a.pmid,
        title: a.title,
        source: a.journal,
        authors: a.authors,
        url: a.url,
        publishedDate: normalizePublishedDate(a.publishedDate),
        abstract: a.abstract,
      }));
    }

    if (candidates.length === 0) {
      console.log(`Ingest for ${category}: 0 candidates found from source (search returned nothing).`);
      return res.status(200).json({ category, fetched: 0, inserted: 0 });
    }

    // 2. Drop anything already in the table (dedup by external_id).
    const { data: existing, error: existingErr } = await supabase
      .from('feed_items')
      .select('external_id')
      .in('external_id', candidates.map((c) => c.externalId));

    if (existingErr) throw existingErr;

    const existingIds = new Set((existing ?? []).map((r) => r.external_id));
    const fresh = candidates.filter((c) => !existingIds.has(c.externalId));

    if (fresh.length === 0) {
      console.log(`Ingest for ${category}: ${candidates.length} candidates found, all already in database (no new items).`);
      return res.status(200).json({ category, fetched: candidates.length, inserted: 0 });
    }

    // 3. Summarize only the new items, in one batched call.
    const summarized = await batchSummarize(fresh);

    // 4. Insert.
    const rows = summarized
      .filter((it) => it.summary !== null && it.summary !== undefined) // skip only true failures, not intentional empty summaries
      .map((it) => ({
        category,
        source: it.source,
        title: it.title,
        authors: it.authors || null,
        url: it.url,
        summary: it.summary,
        published_date: it.publishedDate,
        external_id: it.externalId,
      }));

    const { error: insertErr } = await supabase
      .from('feed_items')
      .upsert(rows, { onConflict: 'external_id', ignoreDuplicates: true });
    if (insertErr) throw insertErr;

    console.log(`Ingest succeeded for ${category}: fetched=${candidates.length} fresh=${fresh.length} inserted=${rows.length} skipped=${fresh.length - rows.length}`);
    return res.status(200).json({ category, fetched: candidates.length, inserted: rows.length });
  } catch (err) {
    console.error(`Ingest failed for ${category}:`, err);
    return res.status(500).json({ category, error: String(err.message || err) });
  }
}
