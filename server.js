import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const BASE_URL = "https://api.piste.gouv.fr/dila/legifrance/lf-engine-app";

// =========================
// 🔧 UTIL SAFE CLEAN
// =========================
function cleanParams(body, allowed) {
  const clean = {};
  for (const key of allowed) {
    if (body[key] !== undefined && body[key] !== null) {
      clean[key] = body[key];
    }
  }
  return clean;
}

// =========================
// 🔐 TOKEN (à adapter si besoin)
// =========================
const TOKEN = process.env.LEGIFRANCE_TOKEN;

async function callAPI(path, payload) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();

  try {
    return JSON.parse(text);
  } catch {
    return { error: "Invalid JSON", raw: text };
  }
}

// =========================
// ❤️ HEALTHCHECK
// =========================
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// =========================
// 🔍 SEARCH SIMPLE (FIX 400)
// =========================
app.post("/searchLegifranceSimple", async (req, res) => {
  const body = cleanParams(req.body, [
    "terms",
    "fond",
    "pageNumber",
    "pageSize",
    "operateur",
    "typePagination",
    "typeChamp",
    "typeRecherche",
  ]);

  try {
    const data = await callAPI("/search", body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// 🔍 SEARCH STRUCTURED SAFE (FIX 400)
// =========================
app.post("/searchLegifranceStructuredSafe", async (req, res) => {
  const body = cleanParams(req.body, [
    "terms",
    "fond",
    "pageNumber",
    "pageSize",
    "operateur",
    "typePagination",
    "typeChamp",
    "typeRecherche",
  ]);

  try {
    const data = await callAPI("/search", body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// 📘 RESOLVE ARTICLE (KEY FIX)
// =========================
app.post("/resolveLegifranceArticle", async (req, res) => {
  const { terms } = req.body;

  try {
    const search = await callAPI("/search", {
      terms,
      fond: "ALL",
      pageNumber: 1,
      pageSize: 1,
    });

    const best = search?.results?.[0];

    if (!best) {
      return res.json({ ok: false, message: "No match" });
    }

    const extract =
      best.sections?.[0]?.extracts?.[0] || null;

    if (!extract) {
      return res.json({ ok: false, message: "No article found" });
    }

    res.json({
      ok: true,
      bestMatch: {
        textId: best.titles?.[0]?.id,
        articleId: extract.id,
        articleNumber: extract.num,
        text: extract.values?.[0],
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// 📘 FETCH ARTICLE (SAFE)
// =========================
app.post("/fetchLegifranceArticle", async (req, res) => {
  const { id, articleNumber, codeTerms } = req.body;

  try {
    // 🔥 STRATÉGIE GAGNANTE → toujours repasser par search
    const query = id
      ? id
      : `article ${articleNumber} ${codeTerms}`;

    const search = await callAPI("/search", {
      terms: query,
      fond: "ALL",
      pageNumber: 1,
      pageSize: 1,
    });

    const best = search?.results?.[0];
    const extract =
      best?.sections?.[0]?.extracts?.[0];

    if (!extract) {
      return res.json({
        ok: false,
        message: "Article not found",
      });
    }

    res.json({
      ok: true,
      article: {
        textId: best.titles?.[0]?.id,
        articleId: extract.id,
        articleNumber: extract.num,
        text: extract.values?.[0],
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// 📚 GET CODE SAFE (FIX 500)
// =========================
app.post("/getLegifranceCodeSafe", async (req, res) => {
  const { codeTerms } = req.body;

  try {
    const search = await callAPI("/search", {
      terms: codeTerms,
      fond: "ALL",
      pageNumber: 1,
      pageSize: 1,
    });

    const best = search?.results?.[0];

    if (!best) {
      return res.json({
        ok: false,
        message: "Code not found",
      });
    }

    res.json({
      ok: true,
      code: {
        textId: best.titles?.[0]?.id,
        title: best.titles?.[0]?.title,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================
// 🚀 START
// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});