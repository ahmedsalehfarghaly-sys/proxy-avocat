import express from "express";

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.CLIENT_ID || "";
const CLIENT_SECRET = process.env.CLIENT_SECRET || "";
const BASE_URL = "https://sandbox-api.piste.gouv.fr/dila/legifrance/lf-engine-app";
const OAUTH_URL = "https://sandbox-oauth.piste.gouv.fr/api/oauth/token";

let accessToken = null;
let tokenExpiry = 0;

function ensureSecrets() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("CLIENT_ID et CLIENT_SECRET sont requis dans l'environnement.");
  }
}

async function getAccessToken() {
  ensureSecrets();
  const now = Date.now();
  if (accessToken && now < tokenExpiry) return accessToken;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: "openid"
  });

  const res = await fetch(OAUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}

  if (!res.ok || !data?.access_token) {
    throw new Error(`OAuth error ${res.status}: ${text}`);
  }

  accessToken = data.access_token;
  tokenExpiry = now + ((data.expires_in || 3600) - 60) * 1000;
  return accessToken;
}

async function callAPI(path, payload) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

async function callAPIGet(path) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

function safeParseInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
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
  const pageNumber = safeParseInt(body.pageNumber, 1);
  const pageSize = Math.min(safeParseInt(body.pageSize, 10), 20);

  return {
    terms,
    payload: {
      fond,
      recherche: {
        pageNumber,
        pageSize,
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

function firstResult(data) {
  return Array.isArray(data?.results) ? data.results[0] : null;
}

function resolvedArticleFromSearchData(data) {
  const best = firstResult(data);
  const extract = best?.sections?.[0]?.extracts?.[0];
  if (!extract) return null;

  return {
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
  };
}

function summarizeSearchData(data, limit = 5) {
  return {
    executionTime: data?.executionTime ?? null,
    totalResultNumber: data?.totalResultNumber ?? null,
    totalArticleResultNumber: data?.totalArticleResultNumber ?? null,
    typePagination: data?.typePagination ?? null,
    results: Array.isArray(data?.results) ? data.results.slice(0, limit) : []
  };
}

function summarizeTableMatieres(node, maxItems = 40) {
  const out = [];

  function walk(cur, path = []) {
    if (!cur || out.length >= maxItems) return;
    if (Array.isArray(cur)) {
      for (const item of cur) {
        if (out.length >= maxItems) break;
        walk(item, path);
      }
      return;
    }
    if (typeof cur !== "object") return;

    const title = cur.title || cur.titre || cur.num || null;
    const id = cur.id || cur.cid || null;
    const kind =
      cur.nature ||
      cur.type ||
      (cur.extracts ? "section" : null) ||
      (cur.values ? "article" : null);

    if (title || id) {
      out.push({
        id,
        title,
        kind,
        path: path.join(" > ") || null
      });
    }

    for (const [k, v] of Object.entries(cur)) {
      if (["title", "titre", "id", "cid", "num", "nature", "type", "values"].includes(k)) continue;
      if (out.length >= maxItems) break;
      if (Array.isArray(v)) {
        for (const item of v) {
          if (out.length >= maxItems) break;
          walk(item, title ? [...path, title] : path);
        }
      } else if (v && typeof v === "object") {
        walk(v, title ? [...path, title] : path);
      }
    }
  }

  walk(node, []);
  return out;
}

async function resolveArticleByTerms(terms) {
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

  return {
    out,
    article: resolvedArticleFromSearchData(out.data)
  };
}

console.log("LOADED PROXY ULTIME V1");

// Health
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Commit clean + raw-compatible route
app.get("/lf/commit", async (req, res) => {
  try {
    const out = await callAPIGet("/misc/commitId");
    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/dila/legifrance/lf-engine-app/misc/commitId", async (req, res) => {
  try {
    const out = await callAPIGet("/misc/commitId");
    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Search handlers
async function handleSearch(req, res) {
  try {
    const { terms, payload } = normalizeSearchBody(req.body || {});
    if (!terms) {
      return res.status(400).json({ ok: false, error: "Le champ 'terms' ou 'query' est requis." });
    }
    const out = await callAPI("/search", payload);
    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.post("/lf/search-simple", handleSearch);
app.post("/searchLegifranceSimple", handleSearch);

app.post("/lf/search-structured-safe", handleSearch);
app.post("/searchLegifranceStructuredSafe", handleSearch);

// Suggestions
async function handleSuggest(req, res, path) {
  try {
    const query = String(req.body?.query || req.body?.searchText || "").trim();
    if (!query) return res.status(400).json({ ok: false, error: "query requis" });
    const out = await callAPI(path, { searchText: query });
    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.post("/lf/suggest", (req, res) => handleSuggest(req, res, "/suggest"));
app.post("/suggestLegifrance", (req, res) => handleSuggest(req, res, "/suggest"));

app.post("/lf/suggest-acco", (req, res) => handleSuggest(req, res, "/suggest/acco"));
app.post("/suggestAccoLegifrance", (req, res) => handleSuggest(req, res, "/suggest/acco"));

// Article resolve
async function handleArticleResolve(req, res) {
  try {
    const terms = String(req.body?.terms || req.body?.query || "").trim();
    if (!terms) return res.status(400).json({ ok: false, error: "terms requis" });

    const { out, article } = await resolveArticleByTerms(terms);

    res.status(out.status).json({
      ok: !!article,
      query: terms,
      totalResultNumber: out.data?.totalResultNumber ?? null,
      bestMatch: article
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.post("/lf/article-resolve", handleArticleResolve);
app.post("/resolveLegifranceArticle", handleArticleResolve);

app.post("/resolveLegifranceArticleV2", async (req, res) => {
  try {
    const articleNumber = String(req.body?.articleNumber || "").trim();
    const codeTerms = String(req.body?.codeTerms || "").trim();
    if (!articleNumber || !codeTerms) {
      return res.status(400).json({ ok: false, error: "articleNumber et codeTerms requis" });
    }
    const terms = `article ${articleNumber} ${codeTerms}`;
    const { out, article } = await resolveArticleByTerms(terms);
    res.status(out.status).json({
      ok: !!article,
      query: terms,
      date: String(req.body?.date || "2024-01-01"),
      bestMatch: article
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Article fetch
async function handleArticleFetch(req, res) {
  try {
    const terms =
      req.body?.terms ||
      req.body?.query ||
      (req.body?.articleNumber && req.body?.codeTerms ? `article ${req.body.articleNumber} ${req.body.codeTerms}` : req.body?.id);

    if (!terms) return res.status(400).json({ ok: false, error: "paramètres insuffisants" });

    const { out, article } = await resolveArticleByTerms(String(terms).trim());

    res.status(out.status).json({
      ok: !!article,
      mode: "resolved_from_search",
      query: String(terms).trim(),
      article,
      searchSummary: summarizeSearchData(out.data, 5)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.post("/lf/article-fetch", handleArticleFetch);
app.post("/fetchLegifranceArticle", handleArticleFetch);

// Code safe
async function handleCodeSafe(req, res) {
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

    const best = firstResult(out.data);
    const title = best?.titles?.[0];

    res.status(out.status).json({
      ok: !!title,
      code: title ? {
        textId: title.id || null,
        title: title.title || null
      } : null,
      searchSummary: summarizeSearchData(out.data, 3)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.post("/lf/code-safe", handleCodeSafe);
app.post("/getLegifranceCodeSafe", handleCodeSafe);

// Code resolve
app.post("/lf/code-resolve", async (req, res) => {
  try {
    const codeTerms = String(req.body?.codeTerms || req.body?.terms || req.body?.query || "").trim();
    if (!codeTerms) return res.status(400).json({ ok: false, error: "codeTerms requis" });

    const search = await callAPI("/search", {
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

    const best = firstResult(search.data);
    const textId = best?.titles?.[0]?.id || null;
    if (!textId) {
      return res.status(search.status).json({
        ok: false,
        searchSummary: summarizeSearchData(search.data, 3)
      });
    }

    const toc = await callAPI("/consult/legi/tableMatieres", {
      textId,
      date: String(req.body?.date || "2024-01-01"),
      nature: "CODE"
    });

    res.status(toc.status).json({
      ok: toc.ok,
      textId,
      title: best?.titles?.[0]?.title || null,
      tableMatieresSummary: summarizeTableMatieres(toc.data, safeParseInt(req.body?.maxItems, 40)),
      searchSummary: summarizeSearchData(search.data, 3)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/resolveLegifranceCode", async (req, res) => {
  try {
    const codeTerms = String(req.body?.codeTerms || req.body?.terms || req.body?.query || "").trim();
    if (!codeTerms) return res.status(400).json({ ok: false, error: "codeTerms requis" });

    const search = await callAPI("/search", {
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

    const best = firstResult(search.data);
    const textId = best?.titles?.[0]?.id || null;
    if (!textId) {
      return res.status(search.status).json({
        ok: false,
        searchSummary: summarizeSearchData(search.data, 3)
      });
    }

    const toc = await callAPI("/consult/legi/tableMatieres", {
      textId,
      date: String(req.body?.date || "2024-01-01"),
      nature: "CODE"
    });

    res.status(toc.status).json({
      ok: toc.ok,
      textId,
      title: best?.titles?.[0]?.title || null,
      tableMatieresSummary: summarizeTableMatieres(toc.data, safeParseInt(req.body?.maxItems, 40)),
      searchSummary: summarizeSearchData(search.data, 3)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Raw passthrough helper
app.post("/raw/request", async (req, res) => {
  try {
    const api = String(req.body?.api || "").trim();
    const method = String(req.body?.method || "GET").toUpperCase();
    const path = String(req.body?.path || "").trim();

    if (api !== "legifrance") {
      return res.status(400).json({ ok: false, error: "Seule l'api legifrance est supportée dans cette version." });
    }
    if (!path) {
      return res.status(400).json({ ok: false, error: "path requis" });
    }

    const token = await getAccessToken();
    const url = `${BASE_URL}${path.startsWith("/") ? path : "/" + path}`;

    const init = {
      method,
      headers: { Authorization: `Bearer ${token}` }
    };

    if (method !== "GET" && method !== "HEAD") {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(req.body?.body || {});
    }

    const rawRes = await fetch(url, init);
    const text = await rawRes.text();
    try {
      res.status(rawRes.status).json(JSON.parse(text));
    } catch {
      res.status(rawRes.status).send(text);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log("Proxy ultime en écoute sur " + PORT);
});
