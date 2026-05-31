import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();
const port = process.env.PORT || 8787;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

function cleanText(value = "", max = 12000) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function buildPrompt({ text, mode, language, context }) {
  const target = cleanText(text, 4500);
  const bookContext = cleanText(context, 2200);
  const modeGuide = {
    word: "Explain the selected word or phrase: meaning, simple synonyms, use in this book line, and one easy example.",
    line: "Explain the selected line: literal meaning, hidden meaning, important terms, and why it matters.",
    summary: "Summarize the passage, explain difficult ideas, and list 4 key takeaways.",
    question: "Answer the reader's question using the selected text and context. Say when the text does not provide enough evidence."
  };

  return [
    "You are a patient book-reading tutor for Indian learners.",
    `Answer mostly in ${language || "Hinglish"} with clear, simple language.`,
    modeGuide[mode] || modeGuide.line,
    "Avoid hallucinating facts. If using outside knowledge, label it clearly.",
    bookContext ? `Book context: ${bookContext}` : "",
    `Selected text: ${target}`
  ].filter(Boolean).join("\n\n");
}

async function callGemini(payload) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return {
      provider: "demo",
      text: "Demo mode: GEMINI_API_KEY set karne ke baad yahan real AI explanation aayegi. Abhi selected text ko simple parts mein todkar padhne, search aur Wikipedia tools test kar sakte ho."
    };
  }

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const response = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: buildPrompt(payload) }]
        }
      ],
      generationConfig: {
        temperature: 0.35,
        maxOutputTokens: 1200
      }
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini request failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim();
  return { provider: "gemini", text: text || "AI ne empty response diya. Thoda aur context select karke try karo." };
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    gemini: Boolean(process.env.GEMINI_API_KEY),
    googleSearch: Boolean(process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX)
  });
});

app.post("/api/explain", async (req, res) => {
  try {
    const { text, mode = "line", language = "Hinglish", context = "" } = req.body || {};
    if (!cleanText(text)) {
      return res.status(400).json({ error: "Text required" });
    }
    res.json(await callGemini({ text, mode, language, context }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const query = cleanText(req.query.q, 240);
    if (!query) return res.status(400).json({ error: "Query required" });

    const key = process.env.GOOGLE_SEARCH_API_KEY;
    const cx = process.env.GOOGLE_SEARCH_CX;
    if (!key || !cx) {
      return res.json({
        demo: true,
        items: [
          {
            title: "Google Search demo mode",
            link: "https://developers.google.com/custom-search/v1/overview",
            snippet: "GOOGLE_SEARCH_API_KEY aur GOOGLE_SEARCH_CX set karne ke baad live search results aayenge."
          }
        ]
      });
    }

    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", key);
    url.searchParams.set("cx", cx);
    url.searchParams.set("q", query);
    url.searchParams.set("num", "5");

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google Search failed: ${response.status} ${await response.text()}`);
    const data = await response.json();
    res.json({
      items: (data.items || []).map((item) => ({
        title: item.title,
        link: item.link,
        snippet: item.snippet
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/wiki", async (req, res) => {
  try {
    const query = cleanText(req.query.q, 160);
    if (!query) return res.status(400).json({ error: "Query required" });

    const searchUrl = new URL("https://en.wikipedia.org/w/api.php");
    searchUrl.search = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: query,
      format: "json",
      origin: "*",
      srlimit: "5"
    }).toString();

    const searchResponse = await fetch(searchUrl);
    if (!searchResponse.ok) throw new Error(`Wikipedia search failed: ${searchResponse.status}`);
    const searchData = await searchResponse.json();
    const pages = searchData.query?.search || [];

    const summaries = await Promise.all(
      pages.slice(0, 3).map(async (page) => {
        const title = encodeURIComponent(page.title.replaceAll(" ", "_"));
        const summaryResponse = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`);
        if (!summaryResponse.ok) return null;
        const summary = await summaryResponse.json();
        return {
          title: summary.title,
          extract: summary.extract,
          url: summary.content_urls?.desktop?.page
        };
      })
    );

    res.json({ items: summaries.filter(Boolean) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Book Reader AI API running on http://localhost:${port}`);
});
