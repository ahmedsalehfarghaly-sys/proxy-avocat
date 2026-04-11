import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const BASE_URL = "https://api.piste.gouv.fr/dila/legifrance/lf-engine-app";

function cleanParams(body, allowed) {
  const clean = {};
  for (const key of allowed) {
    if (body[key] !== undefined && body[key] !== null) {
      clean[key] = body[key];
    }
  }
  return clean;
}

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

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

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

  const data = await callAPI("/search", body);
  res.json(data);
});

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

  const data = await callAPI("/search", body);
  res.json(data);
});

app.post("/resolveLegifranceArticle", async (req, res) => {
  const { terms } = req.body;

  const search = await callAPI("/search", {
    terms,
    fond: "ALL",
    pageNumber: 1,
    pageSize: 1,
  });

  const best = search?.results?.[0];
  const extract = best?.sections?.[0]?.extracts?.[0];

  if (!extract) {
    return res.json({ ok: false });
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
});

app.post("/fetchLegifranceArticle", async (req, res) => {
  const { id, articleNumber, codeTerms } = req.body;

  const query = id ? id : `article ${articleNumber} ${codeTerms}`;

  const search = await callAPI("/search", {
    terms: query,
    fond: "ALL",
    pageNumber: 1,
    pageSize: 1,
  });

  const best = search?.results?.[0];
  const extract = best?.sections?.[0]?.extracts?.[0];

  if (!extract) {
    return res.json({ ok: false });
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
});

app.post("/getLegifranceCodeSafe", async (req, res) => {
  const { codeTerms } = req.body;

  const search = await callAPI("/search", {
    terms: codeTerms,
    fond: "ALL",
    pageNumber: 1,
    pageSize: 1,
  });

  const best = search?.results?.[0];

  if (!best) {
    return res.json({ ok: false });
  }

  res.json({
    ok: true,
    code: {
      textId: best.titles?.[0]?.id,
      title: best.titles?.[0]?.title,
    },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on " + PORT);
});
