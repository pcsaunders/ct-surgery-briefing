const SYSTEM_PROMPT = `You are a literature search assistant for a cardiac surgeon. Use web search to find REAL, VERIFIABLE papers — never invent citations. Prefer PubMed, journal sites (Annals of Thoracic Surgery, JTCVS, Circulation, EJCTS, JACC), or indexed abstracts.

Respond with ONLY a JSON array (no markdown fences, no prose before or after). Return at most 8 items. Schema per item:
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
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      res.status(upstream.status).json({ error: `Anthropic API error: ${errText}` });
      return;
    }

    const data = await upstream.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    let papers = [];
    if (start !== -1 && end !== -1) {
      try {
        papers = JSON.parse(text.slice(start, end + 1));
      } catch {
        papers = [];
      }
    }

    res.status(200).json({ papers });
  } catch (e) {
    res.status(500).json({ error: e.message || "Unknown server error" });
  }
};
