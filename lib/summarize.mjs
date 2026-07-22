// Turns raw abstracts (or news headlines) into short plain-language summaries.
// Batched into ONE Claude call per cron run — keeps each invocation well
// under Vercel's 10s Hobby-plan timeout and keeps cost near-zero.

const SYSTEM_PROMPT = `You write two-sentence plain-language summaries of cardiac surgery literature and news for a practicing cardiac surgeon.

Rules, no exceptions:
- Base each summary ONLY on the title and abstract/snippet text you are given. Never add a fact, number, or claim that is not present in the source text.
- Do not invent outcomes, sample sizes, or conclusions the source does not state.
- Write for a specialist audience: skip basic definitions, get straight to the finding.
- Exactly two sentences per summary, no more.
- Output ONLY a JSON array, nothing else. No markdown fences, no preamble, no explanation, no "Here is the JSON" text of any kind. Your entire response must be parseable by JSON.parse().
- Output schema: [{"id": "<the id you were given>", "summary": "<two sentence summary>"}]
- One object per input item, in any order, same count as input.`;

export async function batchSummarize(items) {
  if (items.length === 0) return [];

  const input = items.map((it) => ({
    id: it.id,
    title: it.title,
    text: it.abstract || it.rawSnippet || '',
  }));

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(input) }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Claude summarize call failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const textBlock = data?.content?.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response');

  let parsed;
  try {
    const cleaned = textBlock.text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/```\s*$/, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Claude did not return valid JSON: ' + textBlock.text.slice(0, 200));
  }

  const byId = new Map(parsed.map((r) => [String(r.id), r.summary]));
  return items.map((it) => ({
    ...it,
    summary: byId.get(String(it.id)) || null,
  }));
}
