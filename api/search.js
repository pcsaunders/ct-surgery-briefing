const SYSTEM_PROMPT = `You are a literature search assistant for a cardiac surgeon. Use web search to find REAL, VERIFIABLE papers — never invent citations. Prefer PubMed, journal sites (Annals of Thoracic Surgery, JTCVS, Circulation, EJCTS, JACC), or indexed abstracts.

Search efficiently — 2 to 3 searches is enough for almost any query. Do not narrate your search process in text; only the final answer should appear as text output.

Respond with ONLY a JSON array (no markdown fences, no prose before or after, no "Here are the results" preamble). Return at most 8 items. Schema per item:
{"title": string, "authors": string (first author + "et al." if more than one), "journal": string, "date": string (e.g. "Jul 2026"), "url": string (real URL from search results, prefer pubmed.ncbi.nlm.nih.gov), "summary": string (max 25 words, the key finding)}
If you cannot find enough real results, return fewer items rather than fabricating. If search finds nothing relevant, return [].`;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY. Add it in your hosting provider's project settings." });
    return;
  }
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== "string") {
    res.status(400).json({ error: "Missing prompt" });
    return;
  }
  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 3000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      }),
    });
    if (!upstream.ok) {
      const errText = await upstream.text();
      res.status(upstream.status).json({ error: `Anthropic API error: ${errText}` });
      return;
    }
    const data = await upstream.json();

    // Take only the LAST text block, not all of them joined. Claude
    // sometimes adds a short text block between search tool calls (e.g.
    // "Let me check that journal too") — joining everything let that
    // commentary's own brackets confuse the JSON extraction below. The
    // final text block is reliably the actual answer.
    const textBlocks = (data.content || []).filter((b) => b.type === "text");
    const text = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text : "";

    let papers = [];

    // First try: strip markdown fences and parse directly.
    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/, "")
      .replace(/```\s*$/, "")
      .trim();
    try {
      papers = JSON.parse(cleaned);
    } catch {
      // Fallback: slice between the first [ and last ] of the cleaned text.
      const start = cleaned.indexOf("[");
      const end = cleaned.lastIndexOf("]");
      if (start !== -1 && end !== -1) {
        try {
          papers = JSON.parse(cleaned.slice(start, end + 1));
        } catch {
          papers = [];
        }
      }
    }

    if (!Array.isArray(papers)) papers = [];
    res.status(200).json({ papers });
  } catch (e) {
    res.status(500).json({ error: e.message || "Unknown server error" });
  }
};
