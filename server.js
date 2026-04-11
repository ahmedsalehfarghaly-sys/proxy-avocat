import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const BASE_URL = "https://api.piste.gouv.fr/dila/legifrance/lf-engine-app";
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
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: { raw: text } };
  }
}

async function callAPIGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
    },
  });

  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: { raw: text } };
  }
}

function normalizeSearchBody(body = {}) {
  const allowedFonds = new Set([
    "ALL", "JORF", "CNIL", "CETAT", "JURI", "JUFI", "CONSTIT",
    "KALI", "CODE_DATE", "CODE_ETAT", "LODA_DATE", "LODA_ETAT",
    "CIRC", "ACCO"
  ]);

  const allowedTypeChamp = new Set([
    "ALL", "TITLE", "ARTICLE", "TEXTE", "MOTS_CLES", "IDCC"
  ]);

  const allowedTypeRecherche = new Set([
    "TOUS_LES_MOTS_DANS_UN_CHAMP",
    "UN_DES_MOTS",
    "EXPRESSION_EXACTE"
  ]);

  const terms = String(body.terms || body.query || "").trim();
  const fond = allowedFonds.has(String(body.fond || "").trim()) ? String(body.fond).trim() : "ALL";
  const typeChamp = allowedTypeChamp.has(String(body.typeChamp || "").trim()) ? String(body.typeChamp).trim() : "ALL";
  const typeRecherche = allowedTypeRecherche.has(String(body.typeRecherche || "").trim())
    ? String(body.typeRecherche).trim()
    : "TOUS_LES_MOTS_DANS_UN_CHAMP";
  const operateur = String(body.operateur || "").trim() === "OU" ? "OU" : "ET";
  const typePagination = String(body.typePagination || "").trim() === "ARTICLE" ? "ARTICLE" : "DEFAUT";

  const pageNumber = parseInt(body.pageNumber || "1", 10);
  const pageSize = parseInt(body.pageSize || "10", 10);

  return {
    terms,
    payload: {
      fond,
      recherche: {
        pageNumber: Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1,
        pageSize: Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 20 ? pageSize : 10,
        operateur,
        typePagination,
        champs: [
          {
            typeChamp,
            operateur,
            criteres: [
              {
                valeur: terms,
                operateur,
                typeRecherche
              }
            ]
          }
        ]
      }
    }
  };
}

console.log("LOADED SERVER VERSION CLEAN");

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/lf/commit", async (req, res) => {
  try {
    const out = await callAPIGet("/misc/commitId");
    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function handleSearch(req, res) {
  const { terms, payload } = normalizeSearchBody(req.body || {});
  if (!terms) {
    return res.status(400).json({ ok: false, error: "Le champ 'terms' ou 'query' est requis." });
  }
  const out = await callAPI("/search", payload);
  res.status(out.status).json(out.data);
}

app.post("/lf/search-simple", handleSearch);
app.post("/lf/search-structured-safe", handleSearch);

app.post("/lf/suggest", async (req, res) => {
  try {
    const query = String(req.body?.query || req.body?.searchText || "").trim();
    if (!query) return res.status(400).json({ ok: false, error: "query requis" });
    const out = await callAPI("/suggest", { searchText: query });
    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/lf/suggest-acco", async (req, res) => {
  try {
    const query = String(req.body?.query || req.body?.searchText || "").trim();
    if (!query) return res.status(400).json({ ok: false, error: "query requis" });
    const out = await callAPI("/suggest/acco", { searchText: query });
    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function resolveArticleFromTerms(terms) {
  const out = await callAPI("/search", {
    fond: "ALL",
    recherche: {
      pageNumber: 1,
      pageSize: 1,
      operateur: "ET",
      typePagination: "DEFAUT",
      champs: [
        {
          typeChamp: "ALL",
          operateur: "ET",
          criteres: [
            {
              valeur: terms,
              operateur: "ET",
              typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP"
            }
          ]
        }
      ]
    }
  });

  const best = out.data?.results?.[0];
  const extract = best?.sections?.[0]?.extracts?.[0];

  return {
    out,
    article: extract ? {
      textId: best?.titles?.[0]?.id || null,
      textTitle: best?.titles?.[0]?.title || null,
      sectionId: best?.sections?.[0]?.id || null,
      sectionTitle: best?.sections?.[0]?.title || null,
      articleId: extract.id || null,
      articleNumber: extract.num || null,
      legalStatus: extract.legalStatus || null,
      dateVersion: extract.dateVersion || null,
      dateDebut: extract.dateDebut || null,
      dateFin: extract.dateFin || null,
      text: extract?.values?.[0] || null
    } : null
  };
}

app.post("/lf/article-resolve", async (req, res) => {
  try {
    const terms = String(req.body?.terms || req.body?.query || "").trim();
    if (!terms) return res.status(400).json({ ok: false, error: "terms requis" });

    const { out, article } = await resolveArticleFromTerms(terms);

    res.status(out.status).json({
      ok: !!article,
      query: terms,
      totalResultNumber: out.data?.totalResultNumber ?? null,
      bestMatch: article
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/lf/article-fetch", async (req, res) => {
  try {
    const terms =
      req.body?.terms ||
      req.body?.query ||
      (req.body?.articleNumber && req.body?.codeTerms ? `article ${req.body.articleNumber} ${req.body.codeTerms}` : req.body?.id);

    if (!terms) return res.status(400).json({ ok: false, error: "paramètres insuffisants" });

    const { out, article } = await resolveArticleFromTerms(String(terms).trim());

    res.status(out.status).json({
      ok: !!article,
      mode: "resolved_from_search",
      query: String(terms).trim(),
      article
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/lf/code-safe", async (req, res) => {
  try {
    const codeTerms = String(req.body?.codeTerms || req.body?.terms || req.body?.query || "").trim();
    if (!codeTerms) return res.status(400).json({ ok: false, error: "codeTerms requis" });

    const out = await callAPI("/search", {
      fond: "ALL",
      recherche: {
        pageNumber: 1,
        pageSize: 1,
        operateur: "ET",
        typePagination: "DEFAUT",
        champs: [
          {
            typeChamp: "ALL",
            operateur: "ET",
            criteres: [
              {
                valeur: codeTerms,
                operateur: "ET",
                typeRecherche: "EXPRESSION_EXACTE"
              }
            ]
          }
        ]
      }
    });

    const best = out.data?.results?.[0];
    const title = best?.titles?.[0];

    res.status(out.status).json({
      ok: !!title,
      code: title ? {
        textId: title.id || null,
        title: title.title || null
      } : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on " + PORT);
});
