import express from "express";

const app = express();
app.use(express.json({ limit: "6mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.CLIENT_ID || "REPLACE_ME_CLIENT_ID";
const CLIENT_SECRET = process.env.CLIENT_SECRET || "REPLACE_ME_CLIENT_SECRET";

const API_CONFIG = {
  legifrance: { basePath: "/dila/legifrance/lf-engine-app" },
  judilibre: { basePath: "/cassation/judilibre/v1.0" }
};

let accessToken = null;
let tokenExpiry = 0;

function assertConfig() {
  if (!CLIENT_ID || CLIENT_ID === "REPLACE_ME_CLIENT_ID") throw new Error("CLIENT_ID manquant");
  if (!CLIENT_SECRET || CLIENT_SECRET === "REPLACE_ME_CLIENT_SECRET") throw new Error("CLIENT_SECRET manquant");
}

async function getToken() {
  assertConfig();
  const now = Date.now();
  if (accessToken && now < tokenExpiry) return accessToken;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: "openid"
  });

  const response = await fetch("https://sandbox-oauth.piste.gouv.fr/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Token error ${response.status}: ${text}`);

  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Réponse token non JSON"); }
  if (!data.access_token) throw new Error("Réponse token invalide: access_token absent");

  accessToken = data.access_token;
  tokenExpiry = now + ((data.expires_in || 3600) - 60) * 1000;
  return accessToken;
}

function normalizeRelativePath(path) {
  if (!path) return "";
  let p = String(path).trim();
  if (!p) return "";
  if (!p.startsWith("/")) p = "/" + p;
  return p.replace(/\/+/g, "/");
}

function normalizeTargetPath(api, path) {
  const cfg = API_CONFIG[api];
  if (!cfg) throw new Error(`API inconnue: ${api}`);
  const rel = normalizeRelativePath(path);
  if (!rel || rel === "/") return cfg.basePath;
  if (rel.startsWith(cfg.basePath + "/") || rel === cfg.basePath) return rel;
  return `${cfg.basePath}${rel}`;
}

function buildQueryString(query) {
  const params = new URLSearchParams();
  if (!query || typeof query !== "object") return "";
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== "") params.append(key, String(item));
      }
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function upstreamRequest({ api, method = "GET", path = "", query = {}, body = undefined }) {
  const token = await getToken();
  const upperMethod = String(method || "GET").toUpperCase();
  const targetPath = normalizeTargetPath(api, path);
  const targetUrl = `https://sandbox-api.piste.gouv.fr${targetPath}${buildQueryString(query)}`;

  const headers = { Authorization: `Bearer ${token}` };
  const init = { method: upperMethod, headers };

  if (upperMethod !== "GET" && upperMethod !== "HEAD") {
    headers["Content-Type"] = "application/json";
    if (body !== undefined) init.body = JSON.stringify(body);
  }

  const response = await fetch(targetUrl, init);
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  let json = null;
  try { json = JSON.parse(text); } catch {}

  return { ok: response.ok, status: response.status, contentType, text, json };
}

function sendUpstreamResult(res, result) {
  res.status(result.status);
  if (result.contentType) res.setHeader("Content-Type", result.contentType);
  return res.send(result.text);
}

function errorResponse(res, error) {
  return res.status(500).json({ ok: false, error: String(error.message || error) });
}

function compactString(s, max = 300) {
  if (typeof s !== "string") return s;
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function ensureTerms(body = {}) {
  const terms = body.terms || body.query || body.searchText || body.q || "";
  return String(terms || "").trim();
}

function extractResultsArray(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.documents)) return payload.documents;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function lfSearchBody({ fond = "ALL", terms, pageNumber = 1, pageSize = 10, operateur = "ET", typePagination = "DEFAUT", typeChamp = "ALL", typeRecherche = "TOUS_LES_MOTS_DANS_UN_CHAMP" }) {
  return {
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
              valeur: String(terms).trim(),
              operateur,
              typeRecherche
            }
          ]
        }
      ]
    }
  };
}

async function lfSearch(args) {
  return upstreamRequest({
    api: "legifrance",
    method: "POST",
    path: "/search",
    body: lfSearchBody(args)
  });
}

function summarizeSearchResult(payload, limit = 10) {
  const results = extractResultsArray(payload);
  const summarized = [];
  for (const item of results.slice(0, limit)) {
    const entry = {
      id: item.id || null,
      title: item.title || null,
      origin: item.origin || null,
      nature: item.nature || null,
      etat: item.etat || item.legalStatus || null
    };

    if (Array.isArray(item.titles) && item.titles[0]) {
      entry.textId = item.titles[0].id || item.titles[0].cid || null;
      entry.textTitle = item.titles[0].title || null;
    }

    if (Array.isArray(item.sections) && item.sections[0]) {
      entry.firstSection = {
        id: item.sections[0].id || null,
        title: item.sections[0].title || null
      };
      if (Array.isArray(item.sections[0].extracts) && item.sections[0].extracts[0]) {
        const ex = item.sections[0].extracts[0];
        entry.firstExtract = {
          id: ex.id || null,
          num: ex.num || ex.title || null,
          legalStatus: ex.legalStatus || null,
          dateVersion: ex.dateVersion || null,
          text: Array.isArray(ex.values) && ex.values[0] ? compactString(ex.values[0], 500) : null
        };
      }
    }

    summarized.push(entry);
  }

  return {
    executionTime: payload?.executionTime ?? null,
    totalResultNumber: payload?.totalResultNumber ?? null,
    totalArticleResultNumber: payload?.totalArticleResultNumber ?? null,
    typePagination: payload?.typePagination ?? null,
    results: summarized
  };
}

function findResolvedArticle(payload) {
  const results = extractResultsArray(payload);
  for (const item of results) {
    const textInfo = Array.isArray(item.titles) && item.titles[0] ? item.titles[0] : {};
    if (Array.isArray(item.sections)) {
      for (const section of item.sections) {
        if (Array.isArray(section.extracts)) {
          for (const ex of section.extracts) {
            return {
              textId: textInfo.id || textInfo.cid || null,
              textTitle: textInfo.title || null,
              sectionId: section.id || null,
              sectionTitle: section.title || null,
              articleId: ex.id || null,
              articleNumber: ex.num || ex.title || null,
              legalStatus: ex.legalStatus || null,
              dateVersion: ex.dateVersion || null,
              dateDebut: ex.dateDebut || null,
              dateFin: ex.dateFin || null,
              text: Array.isArray(ex.values) && ex.values[0] ? ex.values[0] : null
            };
          }
        }
      }
    }
  }
  return null;
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

async function lfCanonicalVersion({ textId, date }) {
  return upstreamRequest({
    api: "legifrance",
    method: "POST",
    path: "/search/canonicalVersion",
    body: { textId, date }
  });
}

async function lfCanonicalArticleVersion({ id, date }) {
  return upstreamRequest({
    api: "legifrance",
    method: "POST",
    path: "/search/canonicalArticleVersion",
    body: { id, date }
  });
}

async function lfLegiTableMatieres({ textId, date, nature = "CODE" }) {
  return upstreamRequest({
    api: "legifrance",
    method: "POST",
    path: "/consult/legi/tableMatieres",
    body: { textId, date, nature }
  });
}

async function lfGetArticleByCid({ cid, date }) {
  return upstreamRequest({
    api: "legifrance",
    method: "POST",
    path: "/consult/getArticleByCid",
    body: { cid, date }
  });
}

async function lfGetArticleByIdOrAlias({ id }) {
  return upstreamRequest({
    api: "legifrance",
    method: "POST",
    path: "/consult/getArticleWithIdEliOrAlias",
    body: { id }
  });
}

function guessCodeTermsFromTextId(textId) {
  const map = {
    "LEGITEXT000006070721": "Code civil",
    "LEGITEXT000006072050": "Code du travail",
    "LEGITEXT000005634379": "Code de commerce"
  };
  return map[textId] || null;
}

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "proxy-adaptateur-legifrance-judilibre-v4" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/lf/commit", async (_req, res) => {
  try {
    const result = await upstreamRequest({ api: "legifrance", method: "GET", path: "/misc/commitId" });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/search-simple", async (req, res) => {
  try {
    const terms = ensureTerms(req.body || {});
    const {
      fond = "ALL",
      pageNumber = 1,
      pageSize = 10,
      operateur = "ET",
      typePagination = "DEFAUT",
      typeChamp = "ALL",
      typeRecherche = "TOUS_LES_MOTS_DANS_UN_CHAMP"
    } = req.body || {};

    if (!terms) return res.status(400).json({ ok: false, error: "Le champ 'terms' ou 'query' est requis." });

    const result = await lfSearch({ fond, terms, pageNumber, pageSize, operateur, typePagination, typeChamp, typeRecherche });
    if (!result.ok) return sendUpstreamResult(res, result);
    return res.json(summarizeSearchResult(result.json || {}));
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/search-structured-safe", async (req, res) => {
  try {
    const terms = ensureTerms(req.body || {});
    const {
      fond = "ALL",
      pageNumber = 1,
      pageSize = 10,
      operateur = "ET",
      typePagination = "DEFAUT",
      typeChamp = "ALL",
      typeRecherche = "TOUS_LES_MOTS_DANS_UN_CHAMP"
    } = req.body || {};

    if (!terms) return res.status(400).json({ ok: false, error: "Le champ 'terms' ou 'query' est requis." });

    const result = await lfSearch({ fond, terms, pageNumber, pageSize, operateur, typePagination, typeChamp, typeRecherche });
    if (!result.ok) return sendUpstreamResult(res, result);
    return res.json(summarizeSearchResult(result.json || {}));
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/suggest", async (req, res) => {
  try {
    const searchText = ensureTerms(req.body || {});
    if (!searchText) return res.status(400).json({ ok: false, error: "Le champ 'query' ou 'searchText' est requis." });

    const result = await upstreamRequest({
      api: "legifrance",
      method: "POST",
      path: "/suggest",
      body: { searchText }
    });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/suggest-acco", async (req, res) => {
  try {
    const searchText = ensureTerms(req.body || {});
    if (!searchText) return res.status(400).json({ ok: false, error: "Le champ 'query' ou 'searchText' est requis." });

    const result = await upstreamRequest({
      api: "legifrance",
      method: "POST",
      path: "/suggest/acco",
      body: { searchText }
    });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/article-by-id", async (req, res) => {
  try {
    const { id, date = "2024-01-01" } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: "Le champ 'id' est requis." });

    const direct = await lfGetArticleByIdOrAlias({ id });
    if (direct.ok && direct.json && direct.json.article) return sendUpstreamResult(res, direct);

    const canonical = await lfCanonicalArticleVersion({ id, date });
    if (canonical.ok && canonical.json) {
      const cid = canonical.json.cid || canonical.json.articleCid || null;
      if (cid) {
        const byCid = await lfGetArticleByCid({ cid, date });
        if (byCid.ok && byCid.json && byCid.json.article) return sendUpstreamResult(res, byCid);
      }
    }

    const fallback = await lfSearch({
      fond: "ALL",
      terms: id,
      pageNumber: 1,
      pageSize: 5,
      operateur: "ET",
      typePagination: "DEFAUT",
      typeChamp: "ALL",
      typeRecherche: "EXPRESSION_EXACTE"
    });

    if (!fallback.ok) return sendUpstreamResult(res, fallback);

    const article = findResolvedArticle(fallback.json || {});
    return res.json({
      ok: true,
      mode: "fallback_search",
      requestedId: id,
      article
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/article-resolve", async (req, res) => {
  try {
    const terms = ensureTerms(req.body || {});
    if (!terms) return res.status(400).json({ ok: false, error: "Le champ 'terms' ou 'query' est requis." });

    const result = await lfSearch({
      fond: "ALL",
      terms,
      pageNumber: 1,
      pageSize: 10,
      operateur: "ET",
      typePagination: "DEFAUT",
      typeChamp: "ALL",
      typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP"
    });

    if (!result.ok) return sendUpstreamResult(res, result);

    const bestMatch = findResolvedArticle(result.json || {});
    return res.json({
      ok: true,
      query: terms,
      totalResultNumber: result.json?.totalResultNumber ?? null,
      bestMatch,
      searchSummary: summarizeSearchResult(result.json || {}, 5)
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/article-resolve-v2", async (req, res) => {
  try {
    const { articleNumber, codeTerms, date = "2024-01-01" } = req.body || {};
    if (!articleNumber || !codeTerms) {
      return res.status(400).json({ ok: false, error: "Les champs 'articleNumber' et 'codeTerms' sont requis." });
    }

    const terms = `article ${articleNumber} ${codeTerms}`;
    const search = await lfSearch({
      fond: "ALL",
      terms,
      pageNumber: 1,
      pageSize: 10,
      operateur: "ET",
      typePagination: "DEFAUT",
      typeChamp: "ALL",
      typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP"
    });

    if (!search.ok) return sendUpstreamResult(res, search);

    const bestMatch = findResolvedArticle(search.json || {});
    return res.json({
      ok: true,
      query: terms,
      date,
      bestMatch,
      searchSummary: summarizeSearchResult(search.json || {}, 5)
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/article-fetch", async (req, res) => {
  try {
    const { cid, id, date = "2024-01-01", terms, articleNumber, codeTerms } = req.body || {};
    if (!cid && !id && !terms && !(articleNumber && codeTerms)) {
      return res.status(400).json({ ok: false, error: "Fournir 'cid', 'id', 'terms' ou ('articleNumber' et 'codeTerms')." });
    }

    if (cid) {
      const byCid = await lfGetArticleByCid({ cid, date });
      if (byCid.ok && byCid.json && byCid.json.article) return sendUpstreamResult(res, byCid);
      return sendUpstreamResult(res, byCid);
    }

    if (id) {
      const direct = await lfGetArticleByIdOrAlias({ id });
      if (direct.ok && direct.json && direct.json.article) return sendUpstreamResult(res, direct);

      const canonical = await lfCanonicalArticleVersion({ id, date });
      if (canonical.ok && canonical.json) {
        const canonicalCid = canonical.json.cid || canonical.json.articleCid || null;
        if (canonicalCid) {
          const byCid = await lfGetArticleByCid({ cid: canonicalCid, date });
          if (byCid.ok && byCid.json && byCid.json.article) return sendUpstreamResult(res, byCid);
        }
      }
    }

    const effectiveTerms = terms || (articleNumber && codeTerms ? `article ${articleNumber} ${codeTerms}` : id);
    const search = await lfSearch({
      fond: "ALL",
      terms: effectiveTerms,
      pageNumber: 1,
      pageSize: 10,
      operateur: "ET",
      typePagination: "DEFAUT",
      typeChamp: "ALL",
      typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP"
    });

    if (!search.ok) return sendUpstreamResult(res, search);

    return res.json({
      ok: true,
      mode: "resolved_from_search",
      query: effectiveTerms,
      article: findResolvedArticle(search.json || {}),
      searchSummary: summarizeSearchResult(search.json || {}, 5)
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/code-safe", async (req, res) => {
  try {
    const { textId, date = "2024-01-01", abrogated = false, searchedString, fromSuggest = false, sctCid } = req.body || {};
    if (!textId) return res.status(400).json({ ok: false, error: "Le champ 'textId' est requis." });

    const body = { textId, date, abrogated, fromSuggest };
    if (searchedString !== undefined) body.searchedString = searchedString;
    if (sctCid !== undefined) body.sctCid = sctCid;

    const direct = await upstreamRequest({
      api: "legifrance",
      method: "POST",
      path: "/consult/code",
      body
    });

    if (direct.ok && direct.json && JSON.stringify(direct.json).length < 200000) {
      return sendUpstreamResult(res, direct);
    }

    const fallbackCodeTerms = guessCodeTermsFromTextId(textId);
    let searchSummary = null;
    if (fallbackCodeTerms) {
      const search = await lfSearch({
        fond: "CODE_ETAT",
        terms: fallbackCodeTerms,
        pageNumber: 1,
        pageSize: 5,
        operateur: "ET",
        typePagination: "DEFAUT",
        typeChamp: "TITLE",
        typeRecherche: "EXPRESSION_EXACTE"
      });
      if (search.ok && search.json) searchSummary = summarizeSearchResult(search.json, 3);
    }

    return res.json({
      ok: true,
      mode: "fallback_summary",
      directStatus: direct.status,
      directError: direct.json || direct.text,
      textId,
      date,
      searchSummary
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/code-resolve", async (req, res) => {
  try {
    const { textId, codeTerms, date = "2024-01-01", nature = "CODE", maxItems = 40 } = req.body || {};
    const effectiveTerms = codeTerms || guessCodeTermsFromTextId(textId);

    let resolvedTextId = textId || null;
    let searchSummary = null;

    if (!resolvedTextId && effectiveTerms) {
      const search = await lfSearch({
        fond: "CODE_ETAT",
        terms: effectiveTerms,
        pageNumber: 1,
        pageSize: 5,
        operateur: "ET",
        typePagination: "DEFAUT",
        typeChamp: "TITLE",
        typeRecherche: "EXPRESSION_EXACTE"
      });
      if (!search.ok) return sendUpstreamResult(res, search);
      searchSummary = summarizeSearchResult(search.json || {}, 3);
      const first = extractResultsArray(search.json || {})[0];
      if (first && Array.isArray(first.titles) && first.titles[0]) {
        resolvedTextId = first.titles[0].id || first.titles[0].cid || null;
      }
    }

    if (!resolvedTextId) {
      return res.status(400).json({ ok: false, error: "Fournir 'textId' ou 'codeTerms'." });
    }

    const canonical = await lfCanonicalVersion({ textId: resolvedTextId, date });
    const toc = await lfLegiTableMatieres({ textId: resolvedTextId, date, nature });

    return res.json({
      ok: true,
      textId: resolvedTextId,
      date,
      nature,
      canonicalStatus: canonical.status,
      canonical: canonical.json || canonical.text,
      tableMatieresStatus: toc.status,
      tableMatieresSummary: toc.json ? summarizeTableMatieres(toc.json, Number(maxItems) || 40) : null,
      searchSummary
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.get("/jd/search", async (req, res) => {
  try {
    const result = await upstreamRequest({ api: "judilibre", method: "GET", path: "/search", query: req.query });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.get("/jd/scan", async (req, res) => {
  try {
    const result = await upstreamRequest({ api: "judilibre", method: "GET", path: "/scan", query: req.query });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.get("/jd/decision", async (req, res) => {
  try {
    const { id } = req.query || {};
    if (!id) return res.status(400).json({ ok: false, error: "Le paramètre 'id' est requis." });

    const result = await upstreamRequest({ api: "judilibre", method: "GET", path: "/decision", query: req.query });

    if (result.ok && result.json && JSON.stringify(result.json).length < 200000) {
      return sendUpstreamResult(res, result);
    }

    if (result.ok && result.json) {
      const j = result.json;
      return res.json({
        ok: true,
        mode: "compact_summary",
        id,
        jurisdiction: j.jurisdiction || null,
        chamber: j.chamber || null,
        decision_date: j.decision_date || null,
        number: j.number || null,
        ecli: j.ecli || null,
        solution: j.solution || null,
        publication: j.publication || null,
        summary: compactString(j.summary || j.solution_summary || "", 1200)
      });
    }

    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/raw/request", async (req, res) => {
  try {
    const { api, method = "GET", path = "/", query = {}, body } = req.body || {};
    if (!api || !API_CONFIG[api]) {
      return res.status(400).json({ ok: false, error: "Le champ 'api' est requis et doit valoir 'legifrance' ou 'judilibre'." });
    }
    const result = await upstreamRequest({ api, method, path, query, body });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.use("/dila/legifrance/lf-engine-app", async (req, res) => {
  try {
    const result = await upstreamRequest({ api: "legifrance", method: req.method, path: req.originalUrl, body: req.body });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.use("/cassation/judilibre/v1.0", async (req, res) => {
  try {
    const result = await upstreamRequest({ api: "judilibre", method: req.method, path: req.originalUrl, body: req.body });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.listen(PORT, () => {
  console.log(`Proxy corrigé v4 lancé sur http://localhost:${PORT}`);
});
