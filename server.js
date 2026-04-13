import express from "express";

const app = express();
app.use(express.json({ limit: "20mb" }));
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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const text = await res.text();
  let data;
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

async function apiRequest({ baseUrl, path, method = "GET", query = {}, body = undefined }) {
  const token = await getAccessToken();
  const url = `${baseUrl}${path}${buildQueryString(query)}`;
  const headers = { Authorization: `Bearer ${token}` };
  const init = { method, headers };

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
    data = { raw: text, parseError: true };
  }

  return { ok: res.ok, status: res.status, data, rawText: text, url };
}

function withMeta(payload, extras = {}) {
  const out = { ...(payload || {}) };
  const results = Array.isArray(out.results) ? out.results : [];
  if (!Number.isFinite(out.totalResultNumber) || (out.totalResultNumber === 0 && results.length > 0)) {
    out.totalResultNumber = results.length;
  }
  if (!Number.isFinite(out.total) && results.length > 0) {
    out.total = results.length;
  }
  out.returnedCount = results.length;
  if (typeof out.ok !== "boolean") out.ok = true;
  return { ...out, ...extras };
}

function safeInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s.\-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s) {
  return normalizeText(s).split(" ").filter(Boolean);
}

function overlapScore(query, text) {
  const q = tokenize(query);
  const t = new Set(tokenize(text));
  let score = 0;
  for (const token of q) {
    if (t.has(token)) score += 1;
  }
  return score;
}

function normalizeResultList(data, limit = 10) {
  return Array.isArray(data?.results) ? data.results.slice(0, limit) : [];
}

function rankJudilibreResults(query, results) {
  const nq = normalizeText(query);
  return [...(results || [])].map((r) => {
    const text = `${r.summary || ""} ${r.chamber || ""} ${r.number || ""} ${r.solution || ""}`;
    let score = overlapScore(nq, text);
    if (/\b\d{2}-\d{2}\.\d{3}\b/.test(query) && String(r.number || "").replace(/\s+/g, "").includes(query.replace(/\s+/g, ""))) score += 5;
    if (nq.includes("syntec") && /syntec/i.test(text)) score += 4;
    if (nq.includes("forfait jours") && /forfait|jours|charge de travail|heures sup/i.test(text)) score += 3;
    return { ...r, _score: score };
  }).sort((a, b) => b._score - a._score).map(({ _score, ...rest }) => rest);
}

function isBroadScanQuery(q) {
  const s = normalizeText(q);
  if (!s) return true;
  const hasPreciseMarker =
    /\b\d{2}-\d{2}\.\d{3}\b/.test(s) ||
    /\becli\b/.test(s) ||
    /\b20\d{2}\b/.test(s) ||
    /"/.test(q);
  if (!hasPreciseMarker) return true;
  if (s.split(" ").length > 10) return true;
  return false;
}

const LF_ALLOWED_FONDS = new Set([
  "ALL", "JORF", "CNIL", "CETAT", "JURI", "JUFI", "CONSTIT", "KALI",
  "CODE_DATE", "CODE_ETAT", "LODA_DATE", "LODA_ETAT", "CIRC", "ACCO"
]);
const LF_ALLOWED_TYPE_CHAMP = new Set(["ALL", "TITLE", "ARTICLE", "TEXTE", "MOTS_CLES", "IDCC"]);
const LF_ALLOWED_TYPE_RECHERCHE = new Set(["TOUS_LES_MOTS_DANS_UN_CHAMP", "UN_DES_MOTS", "EXPRESSION_EXACTE"]);

function normalizeLfSearchBody(body = {}) {
  const terms = String(body.terms || body.query || "").trim();
  let fond = String(body.fond || "").trim() || "ALL";
  if (!LF_ALLOWED_FONDS.has(fond)) fond = "ALL";

  const typeChamp = LF_ALLOWED_TYPE_CHAMP.has(String(body.typeChamp || "").trim())
    ? String(body.typeChamp).trim()
    : "ALL";

  const typeRecherche = LF_ALLOWED_TYPE_RECHERCHE.has(String(body.typeRecherche || "").trim())
    ? String(body.typeRecherche).trim()
    : "TOUS_LES_MOTS_DANS_UN_CHAMP";

  const operateur = String(body.operateur || "").trim() === "OU" ? "OU" : "ET";
  const typePagination = String(body.typePagination || "").trim() === "ARTICLE" ? "ARTICLE" : "DEFAUT";
  const pageNumber = Math.max(safeInt(body.pageNumber, 1), 1);
  const pageSize = Math.min(safeInt(body.pageSize, 10), 100);

  return {
    terms,
    payload: {
      fond,
      recherche: {
        pageNumber,
        pageSize,
        operateur,
        typePagination,
        champs: [{
          typeChamp,
          operateur,
          criteres: [{
            valeur: terms,
            operateur,
            typeRecherche
          }]
        }]
      }
    }
  };
}

function mountGet(route, baseUrl, path) {
  app.get(route, async (req, res) => {
    try {
      const out = await apiRequest({ baseUrl, path, method: "GET", query: req.query });
      res.status(out.status).json(withMeta(out.data, { path_used: path }));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, path_used: path });
    }
  });
}

function mountPost(route, baseUrl, path) {
  app.post(route, async (req, res) => {
    try {
      const out = await apiRequest({ baseUrl, path, method: "POST", body: req.body });
      res.status(out.status).json(withMeta(out.data, { path_used: path }));
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, path_used: path });
    }
  });
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "proxy-avocat",
    version: "v4.2-exhaustive"
  });
});

/* RAW PASS-THROUGH */
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
    if (!path) return res.status(400).json({ ok: false, error: "path requis" });

    const baseUrl = api === "legifrance" ? LF_BASE : JD_BASE;
    const out = await apiRequest({
      baseUrl,
      path: path.startsWith("/") ? path : `/${path}`,
      method,
      query,
      body
    });

    res.status(out.status).json({
      ok: out.ok,
      api_used: api,
      path_used: path,
      ...out.data
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* LEGIFRANCE PING / VERSION */
mountGet("/lf/commit", LF_BASE, "/misc/commitId");
mountGet("/lf/ping/consult", LF_BASE, "/consult/ping");
mountGet("/lf/ping/search", LF_BASE, "/search/ping");
mountGet("/lf/ping/list", LF_BASE, "/list/ping");
mountGet("/lf/ping/suggest", LF_BASE, "/suggest/ping");
mountGet("/lf/ping/chrono", LF_BASE, "/chrono/ping");

/* LEGIFRANCE SEARCH */
app.post("/lf/search-simple", async (req, res) => {
  try {
    const { terms, payload } = normalizeLfSearchBody(req.body || {});
    if (!terms) return res.status(400).json({ ok: false, error: "terms ou query requis" });
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/search", method: "POST", body: payload });
    res.status(out.status).json(withMeta({
      ...out.data,
      results_preview: normalizeResultList(out.data, 10)
    }, {
      query_used: {
        terms,
        fond: payload.fond,
        pageNumber: payload.recherche.pageNumber,
        pageSize: payload.recherche.pageSize
      }
    }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/lf/search-structured-safe", async (req, res) => {
  try {
    const { terms, payload } = normalizeLfSearchBody(req.body || {});
    if (!terms) return res.status(400).json({ ok: false, error: "terms ou query requis" });
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/search", method: "POST", body: payload });
    res.status(out.status).json(withMeta({
      ...out.data,
      results_preview: normalizeResultList(out.data, 10)
    }, {
      query_used: {
        query: terms,
        fond: payload.fond,
        pageNumber: payload.recherche.pageNumber,
        pageSize: payload.recherche.pageSize,
        operateur: payload.recherche.operateur,
        typePagination: payload.recherche.typePagination,
        typeChamp: payload.recherche.champs[0].typeChamp,
        typeRecherche: payload.recherche.champs[0].criteres[0].typeRecherche
      }
    }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

mountPost("/lf/search/canonical-article-version", LF_BASE, "/search/canonicalArticleVersion");
mountPost("/lf/search/canonical-version", LF_BASE, "/search/canonicalVersion");
mountPost("/lf/search/nearest-version", LF_BASE, "/search/nearestVersion");

/* LEGIFRANCE SUGGEST */
app.post("/lf/suggest", async (req, res) => {
  try {
    const query = String(req.body?.query || req.body?.searchText || "").trim();
    if (!query) return res.status(400).json({ ok: false, error: "query requis" });

    const out = await apiRequest({
      baseUrl: LF_BASE,
      path: "/suggest",
      method: "POST",
      body: { searchText: query }
    });

    res.status(out.status).json(withMeta(out.data, { query_used: { query } }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/lf/suggest-acco", async (req, res) => {
  try {
    const query = String(req.body?.query || req.body?.searchText || "").trim();
    if (!query) return res.status(400).json({ ok: false, error: "query requis" });

    const primary = await apiRequest({
      baseUrl: LF_BASE,
      path: "/suggest/acco",
      method: "POST",
      body: { searchText: query }
    });

    let results = Array.isArray(primary.data?.results) ? primary.data.results : [];

    if (!results.length) {
      const fallbackAcco = await apiRequest({
        baseUrl: LF_BASE,
        path: "/search",
        method: "POST",
        body: {
          fond: "ACCO",
          recherche: {
            pageNumber: 1,
            pageSize: 10,
            operateur: "ET",
            typePagination: "DEFAUT",
            champs: [{
              typeChamp: "ALL",
              operateur: "ET",
              criteres: [{
                valeur: query,
                operateur: "ET",
                typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP"
              }]
            }]
          }
        }
      });

      results = normalizeResultList(fallbackAcco.data, 10);

      if (!results.length) {
        const fallbackKali = await apiRequest({
          baseUrl: LF_BASE,
          path: "/search",
          method: "POST",
          body: {
            fond: "KALI",
            recherche: {
              pageNumber: 1,
              pageSize: 10,
              operateur: "ET",
              typePagination: "DEFAUT",
              champs: [{
                typeChamp: "ALL",
                operateur: "ET",
                criteres: [{
                  valeur: query,
                  operateur: "ET",
                  typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP"
                }]
              }]
            }
          }
        });

        return res.status(fallbackKali.status).json(withMeta({
          executionTime: fallbackKali.data?.executionTime ?? primary.data?.executionTime ?? null,
          results: normalizeResultList(fallbackKali.data, 10),
          usedFallback: true
        }, { query_used: { query } }));
      }

      return res.status(fallbackAcco.status).json(withMeta({
        executionTime: fallbackAcco.data?.executionTime ?? primary.data?.executionTime ?? null,
        results,
        usedFallback: true
      }, { query_used: { query } }));
    }

    res.status(primary.status).json(withMeta(primary.data, { query_used: { query } }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

mountPost("/lf/suggest-pdc", LF_BASE, "/suggest/pdc");

/* LEGIFRANCE CONSULT CONTROLLER */
mountPost("/lf/consult/get-cnil-with-ancien-id", LF_BASE, "/consult/getCnilWithAncienId");
mountPost("/lf/consult/get-tables", LF_BASE, "/consult/getTables");
mountPost("/lf/consult/get-article-with-id-eli-or-alias", LF_BASE, "/consult/getArticleWithIdEliOrAlias");
mountPost("/lf/consult/kali-article", LF_BASE, "/consult/kaliArticle");
mountPost("/lf/consult/same-num-article", LF_BASE, "/consult/sameNumArticle");
mountPost("/lf/consult/concordance-links-article", LF_BASE, "/consult/concordanceLinksArticle");
mountPost("/lf/consult/code", LF_BASE, "/consult/code");
mountPost("/lf/consult/kali-cont-idcc", LF_BASE, "/consult/kaliContIdcc");
mountPost("/lf/consult/legi-table-matieres", LF_BASE, "/consult/legi/tableMatieres");
mountPost("/lf/consult/get-article-by-cid", LF_BASE, "/consult/getArticleByCid");
mountPost("/lf/consult/get-juri-plan-classement", LF_BASE, "/consult/getJuriPlanClassement");
mountPost("/lf/consult/service-public-links-article", LF_BASE, "/consult/servicePublicLinksArticle");
mountPost("/lf/consult/cnil", LF_BASE, "/consult/cnil");
mountPost("/lf/consult/jorf-cont", LF_BASE, "/consult/jorfCont");
mountPost("/lf/consult/dossier-legislatif", LF_BASE, "/consult/dossierLegislatif");
mountPost("/lf/consult/juri", LF_BASE, "/consult/juri");
mountPost("/lf/consult/legi-part", LF_BASE, "/consult/legiPart");
mountPost("/lf/consult/get-juri-with-ancien-id", LF_BASE, "/consult/getJuriWithAncienId");
mountPost("/lf/consult/jorf", LF_BASE, "/consult/jorf");
mountPost("/lf/consult/get-code-with-ancien-id", LF_BASE, "/consult/getCodeWithAncienId");
mountPost("/lf/consult/get-jo-with-nor", LF_BASE, "/consult/getJoWithNor");
mountPost("/lf/consult/last-n-jo", LF_BASE, "/consult/lastNJo");
mountPost("/lf/consult/kali-section", LF_BASE, "/consult/kaliSection");
mountPost("/lf/consult/kali-cont", LF_BASE, "/consult/kaliCont");
mountPost("/lf/consult/code-table-matieres-deprecated", LF_BASE, "/consult/code/tableMatieres");
mountPost("/lf/consult/get-bocc-text-pdf-metadata", LF_BASE, "/consult/getBoccTextPdfMetadata");
mountPost("/lf/consult/has-service-public-links-article", LF_BASE, "/consult/hasServicePublicLinksArticle");
mountPost("/lf/consult/get-section-by-cid", LF_BASE, "/consult/getSectionByCid");
mountPost("/lf/consult/debat", LF_BASE, "/consult/debat");
mountPost("/lf/consult/kali-text", LF_BASE, "/consult/kaliText");
mountPost("/lf/consult/get-article", LF_BASE, "/consult/getArticle");
mountPost("/lf/consult/get-article-with-id-and-num", LF_BASE, "/consult/getArticleWithIdAndNum");
mountPost("/lf/consult/law-decree", LF_BASE, "/consult/lawDecree");
mountPost("/lf/consult/eli-and-alias-redirection-texte", LF_BASE, "/consult/eliAndAliasRedirectionTexte");
mountPost("/lf/consult/acco", LF_BASE, "/consult/acco");
mountPost("/lf/consult/jorf-part", LF_BASE, "/consult/jorfPart");
mountPost("/lf/consult/circulaire", LF_BASE, "/consult/circulaire");
mountPost("/lf/consult/related-links-article", LF_BASE, "/consult/relatedLinksArticle");

/* FRIENDLY LF WRAPPERS */
mountPost("/lf/article/by-eli-or-alias", LF_BASE, "/consult/getArticleWithIdEliOrAlias");
mountPost("/lf/article/get", LF_BASE, "/consult/getArticle");
mountPost("/lf/article/by-id-and-num", LF_BASE, "/consult/getArticleWithIdAndNum");
mountPost("/lf/article/by-cid", LF_BASE, "/consult/getArticleByCid");
mountPost("/lf/code/get", LF_BASE, "/consult/code");
mountPost("/lf/code/table-matieres", LF_BASE, "/consult/legi/tableMatieres");
mountPost("/lf/juri/get", LF_BASE, "/consult/juri");
mountPost("/lf/juri/by-ancien-id", LF_BASE, "/consult/getJuriWithAncienId");
mountPost("/lf/juri/plan-classement", LF_BASE, "/consult/getJuriPlanClassement");
mountPost("/lf/jorf/get", LF_BASE, "/consult/jorf");
mountPost("/lf/law-decree/get", LF_BASE, "/consult/lawDecree");
mountPost("/lf/circulaire/get", LF_BASE, "/consult/circulaire");
mountPost("/lf/cnil/get", LF_BASE, "/consult/cnil");
mountPost("/lf/cnil/by-ancien-id", LF_BASE, "/consult/getCnilWithAncienId");
mountPost("/lf/tables/get", LF_BASE, "/consult/getTables");

app.post("/lf/article-resolve", async (req, res) => {
  try {
    const out = await apiRequest({
      baseUrl: LF_BASE,
      path: "/consult/getArticleWithIdEliOrAlias",
      method: "POST",
      body: req.body
    });

    if (out.ok && out.data?.article) {
      return res.status(out.status).json({
        ok: true,
        query_used: req.body,
        bestMatch: out.data.article
      });
    }

    const searchTerms = String(req.body?.terms || req.body?.query || "").trim();
    if (!searchTerms) {
      return res.status(out.status).json(withMeta(out.data, { query_used: req.body }));
    }

    const normalized = normalizeLfSearchBody({ terms: searchTerms, fond: "ALL", pageNumber: 1, pageSize: 1 });
    const fallback = await apiRequest({
      baseUrl: LF_BASE,
      path: "/search",
      method: "POST",
      body: normalized.payload
    });

    const best = Array.isArray(fallback.data?.results) ? fallback.data.results[0] : null;
    return res.status(fallback.status).json({
      ok: !!best,
      query_used: req.body,
      bestMatch: best || null,
      fallback_used: true
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/lf/article-fetch", async (req, res) => {
  try {
    const try1 = await apiRequest({ baseUrl: LF_BASE, path: "/consult/getArticleWithIdAndNum", method: "POST", body: req.body });
    if (try1.ok && (try1.data?.article || try1.data?.text)) {
      return res.status(try1.status).json(withMeta(try1.data, { mode: "getArticleWithIdAndNum" }));
    }

    const try2 = await apiRequest({ baseUrl: LF_BASE, path: "/consult/getArticle", method: "POST", body: req.body });
    if (try2.ok && (try2.data?.article || try2.data?.text)) {
      return res.status(try2.status).json(withMeta(try2.data, { mode: "getArticle" }));
    }

    const try3 = await apiRequest({ baseUrl: LF_BASE, path: "/consult/getArticleByCid", method: "POST", body: req.body });
    return res.status(try3.status).json(withMeta(try3.data, { mode: "getArticleByCid" }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/lf/code-safe", async (req, res) => {
  try {
    const direct = await apiRequest({
      baseUrl: LF_BASE,
      path: "/consult/code",
      method: "POST",
      body: req.body
    });

    if (direct.ok && Object.keys(direct.data || {}).length) {
      return res.status(direct.status).json(withMeta(direct.data, { mode: "consult_code" }));
    }

    const codeTerms = String(req.body?.codeTerms || req.body?.terms || req.body?.query || "").trim();
    if (!codeTerms) return res.status(400).json({ ok: false, error: "codeTerms requis" });

    const normalized = normalizeLfSearchBody({ terms: codeTerms, fond: "ALL", pageNumber: 1, pageSize: 10 });
    const fallback = await apiRequest({
      baseUrl: LF_BASE,
      path: "/search",
      method: "POST",
      body: normalized.payload
    });

    return res.status(fallback.status).json(withMeta({
      code: Array.isArray(fallback.data?.results) ? fallback.data.results[0] || null : null,
      searchSummary: {
        executionTime: fallback.data?.executionTime ?? null,
        totalResultNumber: fallback.data?.totalResultNumber ?? null,
        results: normalizeResultList(fallback.data, 5)
      }
    }, { mode: "search_fallback" }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/lf/code-resolve", async (req, res) => {
  try {
    const direct = await apiRequest({
      baseUrl: LF_BASE,
      path: "/consult/legi/tableMatieres",
      method: "POST",
      body: req.body
    });
    res.status(direct.status).json(withMeta(direct.data, { mode: "legi_tableMatieres" }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* LEGIFRANCE LIST CONTROLLER */
mountPost("/lf/list/docs-admins", LF_BASE, "/list/docsAdmins");
mountPost("/lf/list/bodmr", LF_BASE, "/list/bodmr");
mountPost("/lf/list/dossiers-legislatifs", LF_BASE, "/list/dossiersLegislatifs");
mountPost("/lf/list/questions-ecrites", LF_BASE, "/list/questionsEcritesParlementaires");
mountPost("/lf/list/conventions", LF_BASE, "/list/conventions");
mountPost("/lf/list/loda", LF_BASE, "/list/loda");
mountPost("/lf/list/bocc-texts", LF_BASE, "/list/boccTexts");
mountPost("/lf/list/boccs-and-texts", LF_BASE, "/list/boccsAndTexts");
mountPost("/lf/list/code", LF_BASE, "/list/code");
mountPost("/lf/list/bocc", LF_BASE, "/list/bocc");
mountPost("/lf/list/debats-parlementaires", LF_BASE, "/list/debatsParlementaires");
mountPost("/lf/list/legislatures", LF_BASE, "/list/legislatures");

/* LEGIFRANCE CHRONO CONTROLLER */
mountPost("/lf/chrono/text-cid-and-element-cid", LF_BASE, "/chrono/textCidAndElementCid");
mountGet("/lf/chrono/text-cid/:textCid", LF_BASE, "/chrono/textCid");
mountPost("/lf/chrono/text-cid", LF_BASE, "/chrono/textCid");

/* JUDILIBRE */
mountGet("/jd/healthcheck", JD_BASE, "/healthcheck");

app.get("/jd/search", async (req, res) => {
  try {
    const out = await apiRequest({ baseUrl: JD_BASE, path: "/search", method: "GET", query: req.query });
    const ranked = rankJudilibreResults(String(req.query?.query || ""), Array.isArray(out.data?.results) ? out.data.results : []);
    res.status(out.status).json(withMeta({ ...out.data, results: ranked }, { query_used: req.query }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/jd/decision", async (req, res) => {
  try {
    const out = await apiRequest({ baseUrl: JD_BASE, path: "/decision", method: "GET", query: req.query });
    res.status(out.status).json(withMeta(out.data, { query_used: req.query }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/jd/scan", async (req, res) => {
  try {
    const query = String(req.query?.query || "");
    const batchSize = Math.min(safeInt(req.query?.batch_size, 5), 5);

    if (isBroadScanQuery(query)) {
      return res.status(400).json({
        ok: false,
        error: "requête trop large pour scanJudilibre ; utilisez un pourvoi, un ECLI, une année précise ou une expression exacte entre guillemets",
        query_used: { ...req.query, batch_size: batchSize }
      });
    }

    const queryObj = { ...req.query, batch_size: batchSize };
    const out = await apiRequest({ baseUrl: JD_BASE, path: "/scan", method: "GET", query: queryObj });

    const slimResults = Array.isArray(out.data?.results)
      ? out.data.results.slice(0, 5).map((r) => ({
          id: r.id || null,
          jurisdiction: r.jurisdiction || null,
          chamber: r.chamber || null,
          number: r.number || null,
          decision_date: r.decision_date || null,
          solution: r.solution || null,
          publication: r.publication || null,
          summary: r.summary || null
        }))
      : [];

    res.status(out.status).json(withMeta({ ...out.data, results: slimResults }, { query_used: queryObj }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy V4.2 exhaustive LF + JD en écoute sur ${PORT}`);
});
