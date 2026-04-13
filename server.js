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

function requireSecrets() {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("CLIENT_ID et CLIENT_SECRET sont requis.");
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
        if (item !== undefined && item !== null && item !== "") params.append(key, String(item));
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

function safeInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function normalizeResults(data, limit = 10) {
  return Array.isArray(data?.results) ? data.results.slice(0, limit) : [];
}

function responseOk(payload = {}, extras = {}) {
  return { ok: true, ...payload, ...extras };
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
        criteres: [{
          valeur: terms,
          operateur,
          typeRecherche
        }]
      }]
    }
  };
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

function bestLegiCodeResult(results) {
  return (results || []).find(r =>
    /code/i.test(String(r.nature || "")) ||
    /code/i.test(String(r.title || "")) ||
    /code/i.test(String(r.titre || ""))
  ) || (results || [])[0] || null;
}

function bestArticleResult(results, query) {
  const list = results || [];
  const wanted = String(query || "").match(/article\s+([A-Z]?\d[\w.\-]*)/i)?.[1]?.toLowerCase();
  if (wanted) {
    const exact = list.find(r => {
      const n = String(r?.top_extract?.articleNumber || r?.articleNumber || r?.num || "").toLowerCase();
      return n === wanted;
    });
    if (exact) return exact;
  }
  return list[0] || null;
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "proxy-avocat", version: "v4.3-stable-wrappers" });
});

app.get("/lf/commit", async (req, res) => {
  try {
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/misc/commitId", method: "GET" });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, path_used: "/misc/commitId" });
    res.json(responseOk(out.data, { path_used: "/misc/commitId" }));
  } catch (e) {
    fail(res, 500, e.message, { path_used: "/misc/commitId" });
  }
});

app.get("/jd/healthcheck", async (req, res) => {
  try {
    const out = await apiRequest({ baseUrl: JD_BASE, path: "/healthcheck", method: "GET" });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, path_used: "/healthcheck" });
    res.json(responseOk(out.data, { path_used: "/healthcheck" }));
  } catch (e) {
    fail(res, 500, e.message, { path_used: "/healthcheck" });
  }
});

app.post("/raw/request", async (req, res) => {
  try {
    const api = String(req.body?.api || "").trim();
    const method = String(req.body?.method || "GET").toUpperCase();
    const path = String(req.body?.path || "").trim();
    const query = req.body?.query || {};
    const body = req.body?.body || {};

    if (!["legifrance", "judilibre"].includes(api)) return fail(res, 400, "api doit valoir 'legifrance' ou 'judilibre'");
    if (!path) return fail(res, 400, "path requis");

    const baseUrl = api === "legifrance" ? LF_BASE : JD_BASE;
    const out = await apiRequest({ baseUrl, path: path.startsWith("/") ? path : `/${path}`, method, query, body });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, api_used: api, path_used: path });
    res.json(responseOk(out.data, { api_used: api, path_used: path }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/search-simple", async (req, res) => {
  try {
    const terms = pickQuery(req.body);
    if (!terms) return fail(res, 400, "terms ou query requis");
    const payload = makeSearchPayload({ terms, fond: req.body?.fond || "ALL", pageNumber: req.body?.pageNumber || 1, pageSize: req.body?.pageSize || 10 });
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/search", method: "POST", body: payload });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, query_used: { terms } });
    res.json(responseOk({ ...out.data, returnedCount: normalizeResults(out.data, 10).length, results_preview: normalizeResults(out.data, 10) }, { query_used: { terms, fond: payload.fond } }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/search-structured-safe", async (req, res) => {
  try {
    const terms = pickQuery(req.body);
    if (!terms) return fail(res, 400, "terms ou query requis");
    const payload = makeSearchPayload({
      terms,
      fond: req.body?.fond || "ALL",
      pageNumber: req.body?.pageNumber || 1,
      pageSize: req.body?.pageSize || 10,
      operateur: req.body?.operateur || "ET",
      typeChamp: req.body?.typeChamp || "ALL",
      typeRecherche: req.body?.typeRecherche || "TOUS_LES_MOTS_DANS_UN_CHAMP"
    });
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/search", method: "POST", body: payload });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, query_used: { terms } });
    res.json(responseOk({ ...out.data, returnedCount: normalizeResults(out.data, 10).length, results_preview: normalizeResults(out.data, 10) }, { query_used: { terms, fond: payload.fond } }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/suggest", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    if (!query) return fail(res, 400, "query requis");
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/suggest", method: "POST", body: { searchText: query } });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, query_used: { query } });
    res.json(responseOk({ ...out.data, returnedCount: normalizeResults(out.data, 10).length }, { query_used: { query } }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/article-resolve", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    if (!query) return fail(res, 400, "query, terms ou couple articleNumber/codeTerms requis");
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/search", method: "POST", body: makeSearchPayload({ terms: query, fond: "ALL", pageNumber: 1, pageSize: 5 }) });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, query_used: { query } });
    const best = bestArticleResult(normalizeResults(out.data, 5), query);
    if (!best) return fail(res, 404, "article_not_found", { query_used: { query }, upstream: out.data });
    res.json(responseOk({ query, bestMatch: best, returnedCount: 1 }, { path_used: "/search" }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/article-fetch", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    if (!query) return fail(res, 400, "query, terms ou couple articleNumber/codeTerms requis");
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/search", method: "POST", body: makeSearchPayload({ terms: query, fond: "ALL", pageNumber: 1, pageSize: 5 }) });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, query_used: { query } });
    const best = bestArticleResult(normalizeResults(out.data, 5), query);
    if (!best) return fail(res, 404, "article_not_found", { query_used: { query }, upstream: out.data });
    res.json(responseOk({
      mode: "search_resolved",
      query,
      article: {
        title: best.title || best.titre || null,
        id: best.id || null,
        cid: best.cid || null,
        origin: best.origin || null,
        nature: best.nature || null,
        top_extract: best.top_extract || null,
        extracts: best.extracts || null
      }
    }, { path_used: "/search" }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/code-safe", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    if (!query) return fail(res, 400, "codeTerms, terms ou query requis");
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/search", method: "POST", body: makeSearchPayload({ terms: query, fond: "ALL", pageNumber: 1, pageSize: Math.min(safeInt(req.body?.maxItems, 5), 10) }) });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, query_used: { query } });
    const best = bestLegiCodeResult(normalizeResults(out.data, 10));
    if (!best) return fail(res, 404, "code_not_found", { query_used: { query }, upstream: out.data });
    res.json(responseOk({ mode: "search_fallback", code: best, searchSummary: { totalResultNumber: out.data?.totalResultNumber ?? null, returnedCount: normalizeResults(out.data, 10).length } }, { path_used: "/search", query_used: { query } }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/code-resolve", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    if (!query) return fail(res, 400, "codeTerms, terms ou query requis");
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/search", method: "POST", body: makeSearchPayload({ terms: query, fond: "ALL", pageNumber: 1, pageSize: Math.min(safeInt(req.body?.maxItems, 20), 20) }) });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, query_used: { query } });
    const results = normalizeResults(out.data, 20);
    const best = bestLegiCodeResult(results);
    if (!best) return fail(res, 404, "code_not_found", { query_used: { query }, upstream: out.data });
    res.json(responseOk({ mode: "search_outline", code: best, outline: results }, { path_used: "/search", query_used: { query } }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/jorf/get", async (req, res) => {
  try {
    const nor = String(req.body?.nor || "").trim();
    if (nor) {
      const direct = await apiRequest({ baseUrl: LF_BASE, path: "/consult/getJoWithNor", method: "POST", body: { nor } });
      if (direct.ok) return res.json(responseOk(direct.data, { path_used: "/consult/getJoWithNor" }));
    }

    const fallback = await apiRequest({ baseUrl: LF_BASE, path: "/consult/jorfCont", method: "POST", body: {} });
    if (!fallback.ok) return fail(res, fallback.status, "upstream_error", { upstream: fallback.data, path_used: "/consult/jorfCont" });
    res.json(responseOk(fallback.data, { path_used: "/consult/jorfCont", mode: "fallback_journal" }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/law-decree/get", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    if (!query) return fail(res, 400, "query requis pour les lois/décrets/arrêtés");
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/search", method: "POST", body: makeSearchPayload({ terms: query, fond: "LODA_DATE", pageNumber: 1, pageSize: 10 }) });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, query_used: { query } });
    res.json(responseOk({ ...out.data, results_preview: normalizeResults(out.data, 10) }, { path_used: "/search", query_used: { query, fond: "LODA_DATE" } }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/circulaire/get", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    if (!query) return fail(res, 400, "query requis pour les circulaires");
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/search", method: "POST", body: makeSearchPayload({ terms: query, fond: "CIRC", pageNumber: 1, pageSize: 10 }) });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, query_used: { query } });
    res.json(responseOk({ ...out.data, results_preview: normalizeResults(out.data, 10) }, { path_used: "/search", query_used: { query, fond: "CIRC" } }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/juri/get", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    if (!query) return fail(res, 400, "query requis pour la jurisprudence Légifrance");
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/search", method: "POST", body: makeSearchPayload({ terms: query, fond: "JURI", pageNumber: req.body?.pageNumber || 1, pageSize: req.body?.pageSize || 10 }) });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, query_used: { query } });
    res.json(responseOk({ ...out.data, results_preview: normalizeResults(out.data, 10) }, { path_used: "/search", query_used: { query, fond: "JURI" } }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/list/loda", async (req, res) => {
  try {
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/list/loda", method: "POST", body: { pageNumber: req.body?.pageNumber || 1, pageSize: req.body?.pageSize || 10, ...req.body } });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, path_used: "/list/loda" });
    res.json(responseOk(out.data, { path_used: "/list/loda" }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/list/conventions", async (req, res) => {
  try {
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/list/conventions", method: "POST", body: { pageNumber: req.body?.pageNumber || 1, pageSize: req.body?.pageSize || 10, ...req.body } });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, path_used: "/list/conventions" });
    res.json(responseOk(out.data, { path_used: "/list/conventions" }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/consult/jorf-cont", async (req, res) => {
  try {
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/consult/jorfCont", method: "POST", body: req.body || {} });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, path_used: "/consult/jorfCont" });
    res.json(responseOk(out.data, { path_used: "/consult/jorfCont" }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/consult/get-jo-with-nor", async (req, res) => {
  try {
    const nor = String(req.body?.nor || "").trim();
    if (!nor) return fail(res, 400, "nor requis");
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/consult/getJoWithNor", method: "POST", body: { nor } });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, path_used: "/consult/getJoWithNor" });
    res.json(responseOk(out.data, { path_used: "/consult/getJoWithNor" }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/consult/last-n-jo", async (req, res) => {
  try {
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/consult/lastNJo", method: "POST", body: req.body || {} });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, path_used: "/consult/lastNJo" });
    res.json(responseOk(out.data, { path_used: "/consult/lastNJo" }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/consult/kali-text", async (req, res) => {
  try {
    const idcc = String(req.body?.idcc || "").trim();
    if (idcc) {
      const direct = await apiRequest({ baseUrl: LF_BASE, path: "/consult/kaliContIdcc", method: "POST", body: { idcc } });
      if (direct.ok) return res.json(responseOk(direct.data, { path_used: "/consult/kaliContIdcc", mode: "idcc" }));
    }
    const query = pickQuery(req.body);
    if (!query) return fail(res, 400, "idcc ou query requis");
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/search", method: "POST", body: makeSearchPayload({ terms: query, fond: "KALI", pageNumber: 1, pageSize: 10 }) });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, path_used: "/search" });
    res.json(responseOk({ ...out.data, results_preview: normalizeResults(out.data, 10) }, { path_used: "/search", query_used: { query, fond: "KALI" } }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/consult/acco", async (req, res) => {
  try {
    const query = pickQuery(req.body);
    if (!query) return fail(res, 400, "query requis");
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/search", method: "POST", body: makeSearchPayload({ terms: query, fond: "ACCO", pageNumber: 1, pageSize: 10 }) });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, path_used: "/search" });
    res.json(responseOk({ ...out.data, results_preview: normalizeResults(out.data, 10) }, { path_used: "/search", query_used: { query, fond: "ACCO" } }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.post("/lf/consult/kali-cont-idcc", async (req, res) => {
  try {
    const idcc = String(req.body?.idcc || "").trim();
    if (!idcc) return fail(res, 400, "idcc requis");
    const out = await apiRequest({ baseUrl: LF_BASE, path: "/consult/kaliContIdcc", method: "POST", body: { idcc } });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, path_used: "/consult/kaliContIdcc" });
    res.json(responseOk(out.data, { path_used: "/consult/kaliContIdcc" }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.get("/jd/search", async (req, res) => {
  try {
    const out = await apiRequest({ baseUrl: JD_BASE, path: "/search", method: "GET", query: req.query });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, path_used: "/search" });
    res.json(responseOk(out.data, { path_used: "/search", query_used: req.query }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.get("/jd/decision", async (req, res) => {
  try {
    const id = String(req.query?.id || "").trim();
    if (!id) return fail(res, 400, "id requis");
    const out = await apiRequest({ baseUrl: JD_BASE, path: "/decision", method: "GET", query: req.query });
    if (!out.ok) return fail(res, out.status, "upstream_error", { upstream: out.data, path_used: "/decision" });
    res.json(responseOk(out.data, { path_used: "/decision", query_used: req.query }));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.listen(PORT, () => {
  console.log(`Proxy V4.3 stable wrappers en écoute sur ${PORT}`);
});
