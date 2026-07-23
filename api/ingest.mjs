import { createClient } from '@supabase/supabase-js';
import { searchPubmed, CATEGORY_QUERIES } from '../lib/pubmed.mjs';
import { fetchCardiacNews } from '../lib/google-news.mjs';
import { batchSummarize } from '../lib/summarize.mjs';

const VALID_CATEGORIES = ['coronary', 'valvular', 'structural', 'aortic', 'ecmo', 'news'];

export default async function handler(req, res) {
  // Vercel signs cron-triggered requests with this header automatically.
  // Rejects anyone hitting the URL directly without the secret.
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const category = req.query.category;
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Unknown category: ${category}` });
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
      const items = await fetchCardiacNews({ days: 2, limit: 10 });
      candidates = items.map((it) => ({
        id: it.externalId,
        externalId: it.externalId,
        title: it.title,
        source: it.source,
        url: it.url,
        publishedDate: it.publishedDate,
        rawSnippet: it.rawSnippet,
      }));
    } else {
      const articles = await searchPubmed(CATEGORY_QUERIES[category], { days: 3, retmax: 10 });
      candidates = articles.map((a) => ({
        id: a.pmid,
        externalId: a.pmid,
        title: a.title,
        source: a.journal,
        authors: a.authors,
        url: a.url,
        publishedDate: a.publishedDate,
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
