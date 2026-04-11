import express from "express";

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.CLIENT_ID || "";
const CLIENT_SECRET = process.env.CLIENT_SECRET || "";

const LF_BASE = "https://sandbox-api.piste.gouv.fr/dila/legifrance/lf-engine-app";
const JD_BASE = "https://sandbox-api.piste.gouv.fr/cassation/judilibre/v1.0";
const OAUTH_URL = "https://sandbox-oauth.piste.gouv.fr/api/oauth/token";

let accessToken = null;
let tokenExpiry = 0;

function requireSecrets() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("CLIENT_ID et CLIENT_SECRET sont requis.");
  }
}

async function getAccessToken() {
  requireSecrets();

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
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Réponse OAuth non JSON: ${text}`);
  }

  if (!res.ok || !data?.access_token) {
    throw new Error(`OAuth error ${res.status}: ${text}`);
  }

  accessToken = data.access_token;
  tokenExpiry = now + ((data.expires_in || 3600) - 60) * 1000;
  return accessToken;
}

function buildQueryString(query = {}) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== "") {
          params.append(key, String(item));
        }
      }
    } else {
      params.append(key, String(value));
    }
  }

  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function upstreamJson({ baseUrl, path, method = "GET", query = {}, body = undefined }) {
  const token = await getAccessToken();
  const url = `${baseUrl}${path}${buildQueryString(query)}`;

  const headers = {
    Authorization: `Bearer ${token}`
  };

  const init = {
    method,
    headers
  };

  if (method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }

  const res = await fetch(url, init);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return {
    ok: res.ok,
    status: res.status,
    data
  };
}

function safeInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function normalizeLfSearchBody(body = {}) {
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
  const fond = allowedFonds.has(String(body.fond || "").trim())
    ? String(body.fond).trim()
    : "ALL";

  const typeChamp = allowedTypeChamp.has(String(body.typeChamp || "").trim())
    ? String(body.typeChamp).trim()
    : "ALL";

  const typeRecherche = allowedTypeRecherche.has(String(body.typeRecherche || "").trim())
    ? String(body.typeRecherche).trim()
    : "TOUS_LES_MOTS_DANS_UN_CHAMP";

  const operateur = String(body.operateur || "").trim() === "OU" ? "OU" : "ET";
  const typePagination = String(body.typePagination || "").trim() === "ARTICLE" ? "ARTICLE" : "DEFAUT";
  const pageNumber = safeInt(body.pageNumber, 1);
  const pageSize = Math.min(safeInt(body.pageSize, 10), 20);

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

function firstLfResult(data) {
  return Array.isArray(data?.results) ? data.results[0] : null;
}

function extractResolvedArticle(data) {
  const best = firstLfResult(data);
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

function summarizeLfSearch(data, limit = 5) {
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
  const out = await upstreamJson({
    baseUrl: LF_BASE,
    path: "/search",
    method: "POST",
    body: {
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
    }
  });

  return {
    out,
    article: extractResolvedArticle(out.data)
  };
}

console.log("LOADED PROXY FINAL LF+JD");

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/lf/commit", async (req, res) => {
  try {
    const out = await upstreamJson({
      baseUrl: LF_BASE,
      path: "/misc/commitId",
      method: "GET"
    });
    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/dila/legifrance/lf-engine-app/misc/commitId", async (req, res) => {
  try {
    const out = await upstreamJson({
      baseUrl: LF_BASE,
      path: "/misc/commitId",
      method: "GET"
    });
    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function handleLfSearch(req, res) {
  try {
    const { terms, payload } = normalizeLfSearchBody(req.body || {});
    if (!terms) {
      return res.status(400).json({ ok: false, error: "Le champ 'terms' ou 'query' est requis." });
    }

    const out = await upstreamJson({
      baseUrl: LF_BASE,
      path: "/search",
      method: "POST",
      body: payload
    });

    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.post("/lf/search-simple", handleLfSearch);
app.post("/searchLegifranceSimple", handleLfSearch);

app.post("/lf/search-structured-safe", handleLfSearch);
app.post("/searchLegifranceStructuredSafe", handleLfSearch);

async function handleLfSuggest(req, res, path) {
  try {
    const query = String(req.body?.query || req.body?.searchText || "").trim();
    if (!query) {
      return res.status(400).json({ ok: false, error: "query requis" });
    }

    const out = await upstreamJson({
      baseUrl: LF_BASE,
      path,
      method: "POST",
      body: { searchText: query }
    });

    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.post("/lf/suggest", (req, res) => handleLfSuggest(req, res, "/suggest"));
app.post("/suggestLegifrance", (req, res) => handleLfSuggest(req, res, "/suggest"));

app.post("/lf/suggest-acco", (req, res) => handleLfSuggest(req, res, "/suggest/acco"));
app.post("/suggestAccoLegifrance", (req, res) => handleLfSuggest(req, res, "/suggest/acco"));

async function handleArticleResolve(req, res) {
  try {
    const terms = String(req.body?.terms || req.body?.query || "").trim();
    if (!terms) {
      return res.status(400).json({ ok: false, error: "terms requis" });
    }

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

async function handleArticleFetch(req, res) {
  try {
    const terms =
      req.body?.terms ||
      req.body?.query ||
      (req.body?.articleNumber && req.body?.codeTerms
        ? `article ${req.body.articleNumber} ${req.body.codeTerms}`
        : req.body?.id);

    if (!terms) {
      return res.status(400).json({ ok: false, error: "paramètres insuffisants" });
    }

    const { out, article } = await resolveArticleByTerms(String(terms).trim());

    res.status(out.status).json({
      ok: !!article,
      mode: "resolved_from_search",
      query: String(terms).trim(),
      article,
      searchSummary: summarizeLfSearch(out.data, 5)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.post("/lf/article-fetch", handleArticleFetch);
app.post("/fetchLegifranceArticle", handleArticleFetch);

async function handleCodeSafe(req, res) {
  try {
    const codeTerms = String(req.body?.codeTerms || req.body?.terms || req.body?.query || "").trim();
    if (!codeTerms) {
      return res.status(400).json({ ok: false, error: "codeTerms requis" });
    }

    const out = await upstreamJson({
      baseUrl: LF_BASE,
      path: "/search",
      method: "POST",
      body: {
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
      }
    });

    const best = firstLfResult(out.data);
    const title = best?.titles?.[0];

    res.status(out.status).json({
      ok: !!title,
      code: title
        ? {
            textId: title.id || null,
            title: title.title || null
          }
        : null,
      searchSummary: summarizeLfSearch(out.data, 3)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.post("/lf/code-safe", handleCodeSafe);
app.post("/getLegifranceCodeSafe", handleCodeSafe);

async function handleCodeResolve(req, res) {
  try {
    const codeTerms = String(req.body?.codeTerms || req.body?.terms || req.body?.query || "").trim();
    if (!codeTerms) {
      return res.status(400).json({ ok: false, error: "codeTerms requis" });
    }

    const search = await upstreamJson({
      baseUrl: LF_BASE,
      path: "/search",
      method: "POST",
      body: {
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
      }
    });

    const best = firstLfResult(search.data);
    const textId = best?.titles?.[0]?.id || null;
    const title = best?.titles?.[0]?.title || null;

    if (!textId) {
      return res.status(search.status).json({
        ok: false,
        code: null,
        searchSummary: summarizeLfSearch(search.data, 3)
      });
    }

    const toc = await upstreamJson({
      baseUrl: LF_BASE,
      path: "/consult/legi/tableMatieres",
      method: "POST",
      body: {
        textId,
        date: String(req.body?.date || "2024-01-01"),
        nature: "CODE"
      }
    });

    res.status(toc.status).json({
      ok: toc.ok,
      textId,
      title,
      tableMatieresSummary: summarizeTableMatieres(toc.data, safeInt(req.body?.maxItems, 40)),
      searchSummary: summarizeLfSearch(search.data, 3)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.post("/lf/code-resolve", handleCodeResolve);
app.post("/resolveLegifranceCode", handleCodeResolve);

app.get("/cassation/judilibre/v1.0/healthcheck", async (req, res) => {
  try {
    const out = await upstreamJson({
      baseUrl: JD_BASE,
      path: "/healthcheck",
      method: "GET"
    });
    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function handleJudilibreSearch(req, res) {
  try {
    const out = await upstreamJson({
      baseUrl: JD_BASE,
      path: "/search",
      method: "GET",
      query: req.query
    });
    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.get("/jd/search", handleJudilibreSearch);
app.get("/searchJudilibre", handleJudilibreSearch);

async function handleJudilibreScan(req, res) {
  try {
    const out = await upstreamJson({
      baseUrl: JD_BASE,
      path: "/scan",
      method: "GET",
      query: req.query
    });
    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.get("/jd/scan", handleJudilibreScan);
app.get("/scanJudilibre", handleJudilibreScan);

async function handleJudilibreDecision(req, res) {
  try {
    const out = await upstreamJson({
      baseUrl: JD_BASE,
      path: "/decision",
      method: "GET",
      query: req.query
    });
    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.get("/jd/decision", handleJudilibreDecision);
app.get("/getJudilibreDecision", handleJudilibreDecision);

app.post("/raw/request", async (req, res) => {
  try {
    const api = String(req.body?.api || "").trim();
    const method = String(req.body?.method || "GET").toUpperCase();
    const path = String(req.body?.path || "").trim();
    const query = req.body?.query || {};
    const body = req.body?.body || {};

    if (!["legifrance", "judilibre"].includes(api)) {
      return res.status(400).json({ ok: false, error: "api doit valoir 'legifrance' ou 'judilibre'" });
    }

    if (!path) {
      return res.status(400).json({ ok: false, error: "path requis" });
    }

    const baseUrl = api === "legifrance" ? LF_BASE : JD_BASE;
    const out = await upstreamJson({
      baseUrl,
      path: path.startsWith("/") ? path : `/${path}`,
      method,
      query,
      body
    });

    res.status(out.status).json(out.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy final LF + JD en écoute sur ${PORT}`);
});
