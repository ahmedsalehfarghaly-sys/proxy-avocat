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

function fail(res, status, error, details = {}) {
  return res.status(status).json({ ok: false, error, ...details });
}

async function getAccessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("CLIENT_ID et CLIENT_SECRET sont requis.");
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
  try { data = JSON.parse(text); } catch { throw new Error(`Réponse OAuth non JSON: ${text}`); }
  if (!res.ok || !data?.access_token) throw new Error(`OAuth error ${res.status}: ${text}`);

  accessToken = data.access_token;
  tokenExpiry = now + ((data.expires_in || 3600) - 60) * 1000;
  return accessToken;
}

function buildQueryString(query = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach(x => x !== undefined && x !== null && x !== "" && params.append(k, String(x)));
    else params.append(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function apiRequest({ baseUrl, path, method = "GET", query = {}, body = undefined }) {
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(`${baseUrl}${path}${buildQueryString(query)}`, init);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text, parseError: true }; }
  return { ok: res.ok, status: res.status, data };
}

function responseOk(payload = {}, extras = {}) {
  return { ok: true, ...payload, ...extras };
}

function safeInt(v, d) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : d;
}

function pickQuery(body = {}) {
  return String(
    body.query ||
    body.terms ||
    body.searchText ||
    ((body.articleNumber && body.codeTerms) ? `article ${body.articleNumber} ${body.codeTerms}` : "") ||
    body.codeTerms ||
    body.idcc ||
    ""
  ).trim();
}

function normalizeResults(data, limit = 10) {
  return Array.isArray(data?.results) ? data.results.slice(0, limit) : [];
}

function makeSearchPayload({ terms, fond = "ALL", pageNumber = 1, pageSize = 10, operateur = "ET", typeChamp = "ALL", typeRecherche = "TOUS_LES_MOTS_DANS_UN_CHAMP" }) {
  return {
    fond,
    recherche: {
      pageNumber: Math.max(safeInt(pageNumber, 1), 1),
      pageSize: Math.min(safeInt(pageSize, 10), 20),
      operateur,
      typePagination: "DEFAUT",
      champs: [{
        typeChamp,
        operateur,
        criteres: [{ valeur: terms, operateur, typeRecherche }]
      }]
    }
  };
}

async function searchLegifrance(opts) {
  return apiRequest({ baseUrl: LF_BASE, path: "/search", method: "POST", body: makeSearchPayload(opts) });
}

function articleToken(query = "") {
  return String(query).match(/article\s+([A-Z]?\d[\w.\-]*)/i)?.[1]?.toLowerCase() || null;
}

function normalizeTitle(x) { return String(x || "").trim().toLowerCase(); }
function normalizeCodeTerms(codeTerms = "") {
  const s = normalizeTitle(codeTerms);
  if (!s) return "";
  return s.startsWith("code ") ? s : `code ${s}`;
}
function looksLikeJorfTextId(v = "") { return /^JORFTEXT/i.test(String(v || "").trim()); }

function isLikelyCodeHit(hit, codeTerms = "") {
  const wanted = normalizeCodeTerms(codeTerms);
  const title = normalizeTitle(hit?.title || hit?.titre || hit?.textTitle || "");
  const nature = normalizeTitle(hit?.nature || "");
  if (!/code/.test(nature) && !/code/.test(title)) return false;
  if (!wanted) return true;
  return title === wanted || title.includes(wanted);
}

function bestLegiCodeResult(results, codeTerms = "") {
  return (results || []).find(r => isLikelyCodeHit(r, codeTerms))
    || (results || []).find(r => /code/i.test(String(r.nature || "")) || /code/i.test(String(r.title || "")) || /code/i.test(String(r.titre || "")))
    || null;
}

function bestArticleResult(results, query, codeTerms = "") {
  const wantedArticle = articleToken(query);
  const wantedCode = normalizeCodeTerms(codeTerms || query);
  return (results || []).find(r => {
    const articleNum = String(r?.top_extract?.articleNumber || r?.articleNumber || r?.num || "").toLowerCase();
    const title = normalizeTitle(r?.title || r?.titre || "");
    return (!wantedArticle || articleNum === wantedArticle) && (!wantedCode || title.includes(wantedCode));
  }) || (results || []).find(r => {
    const articleNum = String(r?.top_extract?.articleNumber || r?.articleNumber || r?.num || "").toLowerCase();
    return !wantedArticle || articleNum === wantedArticle;
  }) || (results || [])[0] || null;
}

function summarizeArticleFromHit(hit) {
  if (!hit) return null;
  const te = hit.top_extract || {};
  return {
    title: hit.title || hit.titre || null,
    id: hit.id || te.articleId || hit.articleId || null,
    cid: hit.cid || hit.idTexte || hit.textId || te.textId || null,
    origin: hit.origin || null,
    nature: hit.nature || null,
    articleNumber: te.articleNumber || hit.articleNumber || hit.num || null,
    legalStatus: te.legalStatus || hit.legalStatus || null,
    dateVersion: te.dateVersion || hit.dateVersion || null,
    top_extract: Object.keys(te).length ? te : null,
    extracts: Array.isArray(hit.extracts) ? hit.extracts : null
  };
}

app.get("/health", (req, res) => res.json({ ok: true, service: "proxy-avocat", version: "v4.3.1-fullfix" }));

app.get("/lf/commit", async (req, res) => {
  try {
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/misc/commitId", method: "GET" });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, path_used: "/misc/commitId" });
    res.json(responseOk(out.data, { path_used: "/misc/commitId" }));
  } catch (e) { fail(res, 500, e.message); }
});

app.get("/jd/healthcheck", async (req, res) => {
  try {
    const out = await apiRequest({ baseUrl: JD_BASE, path: "/healthcheck", method: "GET" });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, path_used: "/healthcheck" });
    res.json(responseOk(out.data, { path_used: "/healthcheck" }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/raw/request", async (req, res) => {
  try {
    const api = String(req.body?.api || "").trim();
    const method = String(req.body?.method || "GET").toUpperCase();
    const path = String(req.body?.path || "").trim();
    if (!["legifrance", "judilibre"].includes(api)) return fail(res, 400, "api invalide");
    if (!path) return fail(res, 400, "path requis");
    const out = await apiRequest({
      baseUrl: api === "legifrance" ? LF_BASE : JD_BASE,
      path: path.startsWith("/") ? path : `/${path}`,
      method,
      query: req.body?.query || {},
      body: req.body?.body || {}
    });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, api_used: api, path_used: path });
    res.json(responseOk(out.data, { api_used: api, path_used: path }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/search-simple", async (req, res) => {
  try {
    const terms = pickQuery(req.body);
    if (!terms) return fail(res, 400, "terms ou query requis");
    const out = await searchLegifrance({ terms, fond: req.body?.fond || "ALL", pageNumber: req.body?.pageNumber || 1, pageSize: req.body?.pageSize || 10, operateur: "OU" });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data });
    res.json(responseOk({ ...out.data, returnedCount: normalizeResults(out.data, 10).length, results_preview: normalizeResults(out.data, 10) }, { query_used: { terms } }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/search-structured-safe", async (req, res) => {
  try {
    const terms = pickQuery(req.body);
    if (!terms) return fail(res, 400, "terms ou query requis");
    const out = await searchLegifrance({
      terms,
      fond: req.body?.fond || "ALL",
      pageNumber: req.body?.pageNumber || 1,
      pageSize: req.body?.pageSize || 10,
      operateur: req.body?.operateur || "ET",
      typeChamp: req.body?.typeChamp || "ALL",
      typeRecherche: req.body?.typeRecherche || "TOUS_LES_MOTS_DANS_UN_CHAMP"
    });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data });
    res.json(responseOk({ ...out.data, returnedCount: normalizeResults(out.data, 10).length, results_preview: normalizeResults(out.data, 10) }, { query_used: { terms } }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/suggest", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    if (!query) return fail(res, 400, "query requis");
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/suggest", method: "POST", body: { searchText: query } });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data });
    res.json(responseOk({ ...out.data, returnedCount: normalizeResults(out.data, 10).length }, { query_used: { query } }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/article-resolve", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    const codeTerms = String(req.body?.codeTerms || "").trim();
    if (!query) return fail(res, 400, "query requis");
    const out = await searchLegifrance({ terms: query, fond: "ALL", pageNumber: 1, pageSize: 10, operateur: "ET" });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data });
    const best = bestArticleResult(normalizeResults(out.data, 10), query, codeTerms);
    if (!best) return fail(res, 404, "article_not_found");
    res.json(responseOk({ query, returnedCount: 1, bestMatch: summarizeArticleFromHit(best) }, { path_used: "/search" }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/article-fetch", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    const codeTerms = String(req.body?.codeTerms || "").trim();
    const articleNumber = String(req.body?.articleNumber || "").trim();
    if (!query) return fail(res, 400, "query requis");
    const s = await searchLegifrance({ terms: query, fond: "ALL", pageNumber: 1, pageSize: 10, operateur: "ET" });
    if (!s.ok) return fail(res, s.status, "upstream_error", { upstream: s.data });
    const best = bestArticleResult(normalizeResults(s.data, 10), query, codeTerms);
    if (!best) return fail(res, 404, "article_not_found");
    let article = summarizeArticleFromHit(best);
    const articleId = article?.id || best?.top_extract?.articleId || null;
    const num = article?.articleNumber || articleNumber || null;
    if (articleId && num) {
      const direct = await apiRequest({ baseUrl: LF_BASE, path: "/consult/getArticleWithIdAndNum", method: "POST", body: { id: articleId, num } });
      if (direct.ok && direct.data) {
        const d = direct.data;
        article = {
          ...article,
          title: d.title || d.intitule || article.title || null,
          id: d.id || article.id || null,
          cid: d.cid || d.idTexte || d.textId || article.cid || null,
          text: d.text || d.texte || d.contenu || null,
          dateDebut: d.dateDebut || null,
          dateFin: d.dateFin || null,
          legalStatus: d.legalStatus || d.etat || article.legalStatus || null,
          full: d
        };
        return res.json(responseOk({ mode: "consult_getArticleWithIdAndNum", query, article }, { path_used: "/consult/getArticleWithIdAndNum" }));
      }
    }
    res.json(responseOk({ mode: "search_resolved", query, article }, { path_used: "/search" }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/code-safe", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    const codeTerms = String(req.body?.codeTerms || req.body?.terms || req.body?.query || "").trim();
    if (!query) return fail(res, 400, "query requis");
    const out = await searchLegifrance({ terms: query, fond: "ALL", pageNumber: 1, pageSize: Math.min(safeInt(req.body?.maxItems, 5), 10), operateur: "ET" });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data });
    const best = bestLegiCodeResult(normalizeResults(out.data, 10), codeTerms);
    if (!best) return fail(res, 404, "code_not_found");
    res.json(responseOk({
      mode: "search_fallback",
      code: {
        title: best.title || best.titre || null,
        id: best.id || best.cid || null,
        cid: best.cid || best.id || null,
        origin: best.origin || null,
        nature: best.nature || null,
        legalStatus: best.legalStatus || null
      },
      searchSummary: { totalResultNumber: out.data?.totalResultNumber ?? null, returnedCount: normalizeResults(out.data, 10).length }
    }, { path_used: "/search", query_used: { query } }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/code-resolve", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    const codeTerms = String(req.body?.codeTerms || req.body?.terms || req.body?.query || "").trim();
    if (!query) return fail(res, 400, "query requis");
    const out = await searchLegifrance({ terms: query, fond: "ALL", pageNumber: 1, pageSize: 20, operateur: "ET" });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data });
    const results = normalizeResults(out.data, 20);
    const best = bestLegiCodeResult(results, codeTerms);
    if (!best) return fail(res, 404, "code_not_found");
    const exactTitle = normalizeTitle(best.title || best.titre || "");
    let outline = results.filter(r => {
      const title = normalizeTitle(r.title || r.titre || "");
      return title === exactTitle || title.includes(exactTitle);
    });
    if (!outline.length) outline = results.filter(r => isLikelyCodeHit(r, codeTerms));
    if (!outline.length) outline = [best];
    outline = outline.slice(0, Math.min(safeInt(req.body?.maxItems, 10), 20));
    res.json(responseOk({
      mode: "search_outline_filtered",
      code: {
        title: best.title || best.titre || null,
        id: best.id || best.cid || null,
        cid: best.cid || best.id || null,
        origin: best.origin || null,
        nature: best.nature || null,
        legalStatus: best.legalStatus || null
      },
      outline
    }, { path_used: "/search", query_used: { query } }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/jorf/get", async (req, res) => {
  try {
    const nor = String(req.body?.nor || "").trim();
    if (nor) {
      if (looksLikeJorfTextId(nor)) {
        const t = await apiRequest({ baseUrl: LF_BASE, path: "/consult/jorf", method: "POST", body: { id: nor } });
        if (t.ok) return res.json(responseOk(t.data, { path_used: "/consult/jorf", mode: "jorf_textid" }));
      } else {
        const d = await apiRequest({ baseUrl: LF_BASE, path: "/consult/getJoWithNor", method: "POST", body: { nor } });
        if (d.ok) return res.json(responseOk(d.data, { path_used: "/consult/getJoWithNor", mode: "nor" }));
      }
    }
    const fb = await apiRequest({ baseUrl: LF_BASE, path: "/consult/jorfCont", method: "POST", body: {} });
    if (!fb.ok) return fail(res, fb.status, "upstream_error", { upstream: fb.data });
    res.json(responseOk(fb.data, { path_used: "/consult/jorfCont", mode: "fallback_journal" }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/law-decree/get", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    if (!query) return fail(res, 400, "query requis");
    const out = await searchLegifrance({ terms: query, fond: "LODA_DATE", pageNumber: 1, pageSize: 10, operateur: "ET" });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data });
    res.json(responseOk({ ...out.data, results_preview: normalizeResults(out.data, 10) }, { path_used: "/search", query_used: { query, fond: "LODA_DATE" } }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/circulaire/get", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    if (!query) return fail(res, 400, "query requis");
    const out = await searchLegifrance({ terms: query, fond: "CIRC", pageNumber: 1, pageSize: 10, operateur: "ET" });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data });
    res.json(responseOk({ ...out.data, results_preview: normalizeResults(out.data, 10) }, { path_used: "/search", query_used: { query, fond: "CIRC" } }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/juri/get", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    if (!query) return fail(res, 400, "query requis");
    const out = await searchLegifrance({ terms: query, fond: "JURI", pageNumber: req.body?.pageNumber || 1, pageSize: req.body?.pageSize || 10, operateur: "ET" });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data });
    res.json(responseOk({ ...out.data, results_preview: normalizeResults(out.data, 10) }, { path_used: "/search", query_used: { query, fond: "JURI" } }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/list/loda", async (req, res) => {
  try {
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/list/loda", method: "POST", body: { pageNumber: req.body?.pageNumber || 1, pageSize: req.body?.pageSize || 10, ...req.body } });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data });
    res.json(responseOk(out.data, { path_used: "/list/loda" }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/list/conventions", async (req, res) => {
  try {
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/list/conventions", method: "POST", body: { pageNumber: req.body?.pageNumber || 1, pageSize: req.body?.pageSize || 10, ...req.body } });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data });
    res.json(responseOk(out.data, { path_used: "/list/conventions" }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/consult/jorf-cont", async (req, res) => {
  try {
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/consult/jorfCont", method: "POST", body: req.body || {} });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data });
    res.json(responseOk(out.data, { path_used: "/consult/jorfCont" }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/consult/get-jo-with-nor", async (req, res) => {
  try {
    const nor = String(req.body?.nor || "").trim();
    if (!nor) return fail(res, 400, "nor requis");
    if (looksLikeJorfTextId(nor)) {
      const out = await apiRequest({ baseUrl: LF_BASE, path: "/consult/jorf", method: "POST", body: { id: nor } });
      if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, path_used: "/consult/jorf" });
      return res.json(responseOk(out.data, { path_used: "/consult/jorf", mode: "jorf_textid" }));
    }
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/consult/getJoWithNor", method: "POST", body: { nor } });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, path_used: "/consult/getJoWithNor" });
    res.json(responseOk(out.data, { path_used: "/consult/getJoWithNor", mode: "nor" }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/consult/last-n-jo", async (req, res) => {
  try {
    const direct = await apiRequest({ baseUrl: LF_BASE, path: "/consult/lastNJo", method: "POST", body: req.body || {} });
    if (direct.ok) return res.json(responseOk(direct.data, { path_used: "/consult/lastNJo", mode: "direct" }));
    const fb = await apiRequest({ baseUrl: LF_BASE, path: "/consult/jorfCont", method: "POST", body: {} });
    if (!fb.ok) return fail(res, direct.status || fb.status, "upstream_error", { upstream_lastNJo: direct.data, upstream_jorfCont: fb.data });
    res.json(responseOk(fb.data, { path_used: "/consult/jorfCont", mode: "fallback_journal" }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/consult/kali-text", async (req, res) => {
  try {
    const idcc = String(req.body?.idcc || "").trim();
    if (idcc) {
      const direct = await apiRequest({ baseUrl: LF_BASE, path: "/consult/kaliContIdcc", method: "POST", body: { idcc } });
      if (direct.ok) return res.json(responseOk(direct.data, { path_used: "/consult/kaliContIdcc", mode: "idcc_direct" }));
      const s = await searchLegifrance({ terms: idcc, fond: "KALI", pageNumber: 1, pageSize: 10, operateur: "ET" });
      if (!s.ok) return fail(res, s.status, "upstream_error", { upstream_direct: direct.data, upstream_search: s.data });
      return res.json(responseOk({ totalResultNumber: s.data?.totalResultNumber ?? null, returnedCount: normalizeResults(s.data, 10).length, results_preview: normalizeResults(s.data, 10) }, { path_used: "/search", mode: "idcc_search_fallback", query_used: { idcc, fond: "KALI" } }));
    }
    const query = pickQuery(req.body);
    if (!query) return fail(res, 400, "idcc ou query requis");
    const s = await searchLegifrance({ terms: query, fond: "KALI", pageNumber: 1, pageSize: 10, operateur: "ET" });
    if (!s.ok) return fail(res, s.status, "upstream_error", { upstream: s.data });
    res.json(responseOk({ totalResultNumber: s.data?.totalResultNumber ?? null, returnedCount: normalizeResults(s.data, 10).length, results_preview: normalizeResults(s.data, 10) }, { path_used: "/search", mode: "preview_only", query_used: { query, fond: "KALI" } }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/consult/acco", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    if (!query) return fail(res, 400, "query requis");
    const out = await searchLegifrance({ terms: query, fond: "ACCO", pageNumber: 1, pageSize: 10, operateur: "ET" });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data });
    res.json(responseOk({ totalResultNumber: out.data?.totalResultNumber ?? null, returnedCount: normalizeResults(out.data, 10).length, results_preview: normalizeResults(out.data, 10) }, { path_used: "/search", query_used: { query, fond: "ACCO" } }));
  } catch (e) { fail(res, 500, e.message); }
});

app.post("/lf/consult/kali-cont-idcc", async (req, res) => {
  try {
    const idcc = String(req.body?.idcc || "").trim();
    if (!idcc) return fail(res, 400, "idcc requis");
    const direct = await apiRequest({ baseUrl: LF_BASE, path: "/consult/kaliContIdcc", method: "POST", body: { idcc } });
    if (direct.ok) return res.json(responseOk(direct.data, { path_used: "/consult/kaliContIdcc", mode: "direct" }));
    const s = await searchLegifrance({ terms: idcc, fond: "KALI", pageNumber: 1, pageSize: 10, operateur: "ET" });
    if (!s.ok) return fail(res, s.status, "upstream_error", { upstream_direct: direct.data, upstream_search: s.data });
    res.json(responseOk({ totalResultNumber: s.data?.totalResultNumber ?? null, returnedCount: normalizeResults(s.data, 10).length, results_preview: normalizeResults(s.data, 10) }, { path_used: "/search", mode: "idcc_search_fallback", query_used: { idcc, fond: "KALI" } }));
  } catch (e) { fail(res, 500, e.message); }
});

app.get("/jd/search", async (req, res) => {
  try {
    const out = await apiRequest({ baseUrl: JD_BASE, path: "/search", method: "GET", query: req.query });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data });
    res.json(responseOk(out.data, { path_used: "/search", query_used: req.query }));
  } catch (e) { fail(res, 500, e.message); }
});

app.get("/jd/decision", async (req, res) => {
  try {
    const id = String(req.query?.id || "").trim();
    if (!id) return fail(res, 400, "id requis");
    const out = await apiRequest({ baseUrl: JD_BASE, path: "/decision", method: "GET", query: req.query });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data });
    res.json(responseOk(out.data, { path_used: "/decision", query_used: req.query }));
  } catch (e) { fail(res, 500, e.message); }
});

app.listen(PORT, () => console.log(`Proxy V4.3.1 fullfix en écoute sur ${PORT}`));
