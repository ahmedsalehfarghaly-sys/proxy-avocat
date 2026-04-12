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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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

  return { ok: res.ok, status: res.status, data, rawText: text };
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
    .replace(/[^\p{L}\p{N}\s.-]/gu, " ")
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

function withMeta(payload, queryUsed = null) {
  const out = { ...(payload || {}) };
  const results = Array.isArray(out.results) ? out.results : [];
  out.returnedCount = results.length;
  if (!Number.isFinite(out.totalResultNumber) || (out.totalResultNumber === 0 && results.length > 0)) {
    out.totalResultNumber = results.length;
  }
  if (queryUsed) out.query_used = queryUsed;
  if (typeof out.ok !== "boolean") out.ok = true;
  return out;
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

const LF_ALLOWED_FONDS = new Set([
  "ALL", "JORF", "CNIL", "CETAT", "JURI", "JUFI", "CONSTIT", "KALI",
  "CODE_DATE", "CODE_ETAT", "LODA_DATE", "LODA_ETAT", "CIRC", "ACCO"
]);

const LF_ALLOWED_TYPE_CHAMP = new Set([
  "ALL", "TITLE", "ARTICLE", "TEXTE", "MOTS_CLES", "IDCC"
]);

const LF_ALLOWED_TYPE_RECHERCHE = new Set([
  "TOUS_LES_MOTS_DANS_UN_CHAMP",
  "UN_DES_MOTS",
  "EXPRESSION_EXACTE"
]);

const UNSAFE_FONDS_FOR_SAFE_SEARCH = new Set([
  "CODE_DATE", "CODE_ETAT", "LODA_DATE", "LODA_ETAT"
]);

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
        champs: [{
          typeChamp: "ALL",
          operateur: "ET",
          criteres: [{
            valeur: terms,
            operateur: "ET",
            typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP"
          }]
        }]
      }
    }
  });

  return { out, article: extractResolvedArticle(out.data) };
}

function rankSuggestionResults(query, results) {
  const nq = normalizeText(query);

  return [...results]
    .map((r) => {
      const label = r.label || r.title || r.raisonSociale || "";
      const cat = r.categorie || "";
      const nature = r.nature || "";
      let score = overlapScore(query, label);

      if (/article/i.test(label) && /\barticle\b/i.test(query)) score += 4;
      if (/code/i.test(label) && /\bcode\b/i.test(query)) score += 4;
      if (cat === "ARTICLE") score += 2;
      if (nature === "CODE") score += 2;

      if (/rupture brutale|relations commerciales|licenciement|forfait jours|contrat intermittent|responsabilite civile/i.test(nq)) {
        if (/code des relations entre le public/i.test(normalizeText(label))) score -= 5;
      }

      return { ...r, _score: score };
    })
    .sort((a, b) => b._score - a._score);
}

function looksLikeLongLegalQuery(query) {
  const q = normalizeText(query);
  return q.split(" ").length >= 4 || /rupture brutale|relations commerciales|responsabilite civile|faute grave|forfait jours|harcelement|rupture conventionnelle/i.test(q);
}

function buildPseudoSuggestionsFromSearch(searchData) {
  const results = Array.isArray(searchData?.results) ? searchData.results : [];
  return results.slice(0, 10).map((r) => ({
    id: r.id || r.cid || r.textId || null,
    label: r.title || r.titre || (r.titles && r.titles[0]?.title) || "Résultat Légifrance",
    origin: r.origin || r.origine || null,
    nature: r.nature || null,
    categorie: r.categorie || "SEARCH_FALLBACK"
  }));
}

function isMeaningfulAccoResult(r) {
  const label = normalizeText(r.label || r.title || "");
  const isEntrepriseOnly = !!r.siret && !!r.raisonSociale && !r.id && !r.idcc && !r.label && !r.title;
  if (isEntrepriseOnly) return false;

  return Boolean(r.id || r.idcc || r.label || r.title) &&
    /accord|convention|avenant|idcc|collective|temps de travail|forfait|metallurgie|syntec|rupture conventionnelle/i.test(label);
}

function filterAccoSuggestions(query, results) {
  return rankSuggestionResults(query, (results || []).filter(isMeaningfulAccoResult))
    .map(({ _score, ...x }) => x);
}

function normalizeAccoSearchResults(results = []) {
  return results.map((r) => ({
    id: r.id || r.cid || null,
    label: r.title || r.titre || r.label || "",
    origin: r.origin || r.origine || "ACCO",
    nature: r.nature || null,
    dateVersion: r.dateVersion || r.date || null,
    categorie: r.categorie || "TITLE"
  }));
}

function simplifyAccoQuery(query) {
  let q = normalizeText(query);
  q = q
    .replace(/\bconvention collective nationale\b/g, "")
    .replace(/\bconvention collective\b/g, "")
    .replace(/\baccord national\b/g, "")
    .replace(/\bidcc\b/g, "idcc")
    .trim();

  return q || normalizeText(query);
}

async function searchAccoOrKali(query, fond = "ACCO") {
  const searchOut = await upstreamJson({
    baseUrl: LF_BASE,
    path: "/search",
    method: "POST",
    body: {
      fond,
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

  const results = normalizeAccoSearchResults(
    Array.isArray(searchOut.data?.results) ? searchOut.data.results : []
  );

  return { searchOut, results };
}

function extractBestCodeFromSearch(data, codeTerms) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const target = normalizeText(codeTerms || "");

  const ranked = results.map((item) => {
    const titleObj = Array.isArray(item?.titles) ? item.titles[0] : null;
    const title = titleObj?.title || item?.title || "";
    const nt = normalizeText(title);

    let score = 0;
    if (item?.nature === "CODE") score += 20;
    if (item?.origin === "LEGI") score += 10;
    if (/^code\b/i.test(title)) score += 20;
    if (nt === target) score += 50;
    if (nt.startsWith(target)) score += 25;
    if (target.startsWith("code ") && nt.includes(target)) score += 20;

    score += overlapScore(target, title);

    return { item, titleObj, title, score };
  }).sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score <= 0) return null;

  return {
    textId: best.titleObj?.id || best.titleObj?.cid || best.item?.id || null,
    title: best.title || null,
    origin: best.item?.origin || null,
    nature: best.item?.nature || null
  };
}

function rankJudilibreResults(query, results) {
  const nq = normalizeText(query);

  return [...results]
    .map((r) => {
      const text = `${r.summary || ""} ${r.chamber || ""} ${r.number || ""}`;
      let score = overlapScore(nq, text);

      if (nq.includes("syntec") && /syntec/i.test(text)) score += 4;
      if (nq.includes("forfait jours") && /forfait|jours|charge de travail|heures sup/i.test(text)) score += 3;
      if (/\b23-23\.507\b/.test(nq) && String(r.number || "").includes("23-23.507")) score += 6;

      return { ...r, _score: score };
    })
    .sort((a, b) => b._score - a._score)
    .map(({ _score, ...x }) => x);
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

console.log("LOADED PROXY V3.1 LF+JD");

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "proxy-avocat", version: "v3.1" });
});

async function safeHealthcheck(baseUrl, path) {
  try {
    const out = await upstreamJson({ baseUrl, path, method: "GET" });

    if (out.data?.parseError) {
      return {
        ok: false,
        status: out.status,
        data: { ok: false, parseError: true, raw: out.rawText || null, path }
      };
    }

    return out;
  } catch (e) {
    return {
      ok: false,
      status: 500,
      data: { ok: false, error: e.message, path }
    };
  }
}

app.get("/lf/commit", async (req, res) => {
  const out = await safeHealthcheck(LF_BASE, "/misc/commitId");
  res.status(out.status || 500).json(out.data);
});

app.get("/dila/legifrance/lf-engine-app/misc/commitId", async (req, res) => {
  const out = await safeHealthcheck(LF_BASE, "/misc/commitId");
  res.status(out.status || 500).json(out.data);
});

async function handleLfSearch(req, res, options = { safeFondFallback: false }) {
  try {
    const { terms, payload } = normalizeLfSearchBody(req.body || {});
    if (!terms) {
      return res.status(400).json({ ok: false, error: "Le champ 'terms' ou 'query' est requis." });
    }

    let bodyToSend = payload;
    let usedFondFallback = false;

    if (options.safeFondFallback && UNSAFE_FONDS_FOR_SAFE_SEARCH.has(bodyToSend.fond)) {
      bodyToSend = { ...bodyToSend, fond: "ALL" };
      usedFondFallback = true;
    }

    let out = await upstreamJson({
      baseUrl: LF_BASE,
      path: "/search",
      method: "POST",
      body: bodyToSend
    });

    if (!out.ok && bodyToSend.fond !== "ALL") {
      bodyToSend = { ...bodyToSend, fond: "ALL" };
      usedFondFallback = true;

      out = await upstreamJson({
        baseUrl: LF_BASE,
        path: "/search",
        method: "POST",
        body: bodyToSend
      });
    }

    res.status(out.status).json(withMeta({
      ...out.data,
      usedFondFallback
    }, {
      terms: req.body?.terms,
      query: req.body?.query,
      fond: bodyToSend.fond,
      pageNumber: bodyToSend.recherche.pageNumber,
      pageSize: bodyToSend.recherche.pageSize
    }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

app.post("/lf/search-simple", (req, res) => handleLfSearch(req, res, { safeFondFallback: false }));
app.post("/searchLegifranceSimple", (req, res) => handleLfSearch(req, res, { safeFondFallback: false }));
app.post("/lf/search-structured-safe", (req, res) => handleLfSearch(req, res, { safeFondFallback: true }));
app.post("/searchLegifranceStructuredSafe", (req, res) => handleLfSearch(req, res, { safeFondFallback: true }));

async function handleSuggestLegifrance(req, res) {
  try {
    const query = String(req.body?.query || req.body?.searchText || "").trim();
    if (!query) return res.status(400).json({ ok: false, error: "query requis" });

    const suggestOut = await upstreamJson({
      baseUrl: LF_BASE,
      path: "/suggest",
      method: "POST",
      body: { searchText: query }
    });

    let results = Array.isArray(suggestOut.data?.results) ? suggestOut.data.results : [];
    results = rankSuggestionResults(query, results)
      .filter((r) => r._score > 0)
      .slice(0, 10)
      .map(({ _score, ...x }) => x);

    let usedFallback = false;

    if (!results.length && looksLikeLongLegalQuery(query)) {
      usedFallback = true;

      const searchOut = await upstreamJson({
        baseUrl: LF_BASE,
        path: "/search",
        method: "POST",
        body: {
          fond: "ALL",
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

      const fallbackResults = buildPseudoSuggestionsFromSearch(searchOut.data);

      return res.status(searchOut.status).json(withMeta({
        ok: true,
        executionTime: searchOut.data?.executionTime ?? suggestOut.data?.executionTime ?? null,
        results: fallbackResults,
        usedFallback,
        source_quality: "search_fallback"
      }, { query }));
    }

    res.status(suggestOut.status).json(withMeta({
      ...suggestOut.data,
      results,
      usedFallback,
      source_quality: "suggestion_only"
    }, { query }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

app.post("/lf/suggest", handleSuggestLegifrance);
app.post("/suggestLegifrance", handleSuggestLegifrance);

async function handleSuggestAcco(req, res) {
  try {
    const query = String(req.body?.query || req.body?.searchText || "").trim();
    if (!query) return res.status(400).json({ ok: false, error: "query requis" });

    let usedFallback = false;

    const suggestOut = await upstreamJson({
      baseUrl: LF_BASE,
      path: "/suggest/acco",
      method: "POST",
      body: { searchText: query }
    });

    let results = Array.isArray(suggestOut.data?.results) ? suggestOut.data.results : [];
    results = filterAccoSuggestions(query, results);

    if (!results.length) {
      usedFallback = true;

      let { searchOut, results: fallbackResults } = await searchAccoOrKali(query, "ACCO");
      fallbackResults = filterAccoSuggestions(query, fallbackResults).slice(0, 10);

      if (!fallbackResults.length) {
        const simplified = simplifyAccoQuery(query);
        if (simplified && simplified !== query) {
          const second = await searchAccoOrKali(simplified, "ACCO");
          fallbackResults = filterAccoSuggestions(simplified, second.results).slice(0, 10);
          searchOut = second.searchOut;
        }
      }

      if (!fallbackResults.length) {
        const third = await searchAccoOrKali(query, "KALI");
        fallbackResults = filterAccoSuggestions(query, third.results).slice(0, 10);
        searchOut = third.searchOut;
      }

      return res.status(searchOut.status).json(withMeta({
        executionTime: searchOut.data?.executionTime ?? suggestOut.data?.executionTime ?? null,
        results: fallbackResults,
        usedFallback
      }, { query }));
    }

    res.status(suggestOut.status).json(withMeta({
      ...suggestOut.data,
      results: results.slice(0, 10),
      usedFallback
    }, { query }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

app.post("/lf/suggest-acco", handleSuggestAcco);
app.post("/suggestAccoLegifrance", handleSuggestAcco);

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
    res.status(500).json({ ok: false, error: e.message });
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
    res.status(500).json({ ok: false, error: e.message });
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
    res.status(500).json({ ok: false, error: e.message });
  }
}

app.post("/lf/article-fetch", handleArticleFetch);
app.post("/fetchLegifranceArticle", handleArticleFetch);

async function handleCodeSafe(req, res) {
  try {
    const codeTerms = String(req.body?.codeTerms || req.body?.terms || req.body?.query || "").trim();
    if (!codeTerms) return res.status(400).json({ ok: false, error: "codeTerms requis" });

    const out = await upstreamJson({
      baseUrl: LF_BASE,
      path: "/search",
      method: "POST",
      body: {
        fond: "ALL",
        recherche: {
          pageNumber: 1,
          pageSize: 10,
          operateur: "ET",
          typePagination: "DEFAUT",
          champs: [{
            typeChamp: "ALL",
            operateur: "ET",
            criteres: [{
              valeur: codeTerms,
              operateur: "ET",
              typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP"
            }]
          }]
        }
      }
    });

    const code = extractBestCodeFromSearch(out.data, codeTerms);

    res.status(out.status).json({
      ok: !!code,
      code,
      searchSummary: summarizeLfSearch(out.data, 5)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

app.post("/lf/code-safe", handleCodeSafe);
app.post("/getLegifranceCodeSafe", handleCodeSafe);

async function handleCodeResolve(req, res) {
  try {
    const codeTerms = String(req.body?.codeTerms || req.body?.terms || req.body?.query || "").trim();
    if (!codeTerms) return res.status(400).json({ ok: false, error: "codeTerms requis" });

    const search = await upstreamJson({
      baseUrl: LF_BASE,
      path: "/search",
      method: "POST",
      body: {
        fond: "ALL",
        recherche: {
          pageNumber: 1,
          pageSize: 10,
          operateur: "ET",
          typePagination: "DEFAUT",
          champs: [{
            typeChamp: "ALL",
            operateur: "ET",
            criteres: [{
              valeur: codeTerms,
              operateur: "ET",
              typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP"
            }]
          }]
        }
      }
    });

    const code = extractBestCodeFromSearch(search.data, codeTerms);
    if (!code?.textId) {
      return res.status(search.status).json({
        ok: false,
        code: null,
        searchSummary: summarizeLfSearch(search.data, 5)
      });
    }

    const maxItems = safeInt(req.body?.maxItems, 40);

    const toc = await upstreamJson({
      baseUrl: LF_BASE,
      path: "/consult/legi/tableMatieres",
      method: "POST",
      body: {
        textId: code.textId,
        date: String(req.body?.date || "2024-01-01"),
        nature: "CODE"
      }
    });

    const items = summarizeTableMatieres(toc.data, maxItems);

    res.status(toc.status).json({
      ok: toc.ok,
      code,
      returnedCount: items.length,
      truncated: items.length >= maxItems,
      tableMatieresSummary: items,
      searchSummary: summarizeLfSearch(search.data, 5)
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

app.post("/lf/code-resolve", handleCodeResolve);
app.post("/resolveLegifranceCode", handleCodeResolve);

app.get("/cassation/judilibre/v1.0/healthcheck", async (req, res) => {
  const out = await safeHealthcheck(JD_BASE, "/healthcheck");
  res.status(out.status || 500).json(out.data);
});

app.get("/jd/healthcheck", async (req, res) => {
  const out = await safeHealthcheck(JD_BASE, "/healthcheck");
  res.status(out.status || 500).json(out.data);
});

async function handleJudilibreSearch(req, res) {
  try {
    const out = await upstreamJson({
      baseUrl: JD_BASE,
      path: "/search",
      method: "GET",
      query: req.query
    });

    const results = rankJudilibreResults(
      String(req.query?.query || ""),
      Array.isArray(out.data?.results) ? out.data.results : []
    );

    res.status(out.status).json(withMeta({
      ...out.data,
      results
    }, req.query));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

app.get("/jd/search", handleJudilibreSearch);
app.get("/searchJudilibre", handleJudilibreSearch);

async function handleJudilibreScan(req, res) {
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

    const out = await upstreamJson({
      baseUrl: JD_BASE,
      path: "/scan",
      method: "GET",
      query: queryObj
    });

    const rawResults = Array.isArray(out.data?.results) ? out.data.results : [];
    const slimResults = rawResults.slice(0, 5).map((r) => ({
      id: r.id || null,
      jurisdiction: r.jurisdiction || null,
      chamber: r.chamber || null,
      number: r.number || null,
      decision_date: r.decision_date || null,
      solution: r.solution || null,
      publication: r.publication || null,
      summary: r.summary || null
    }));

    res.status(out.status).json(withMeta({
      ...out.data,
      results: slimResults
    }, queryObj));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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
    res.status(500).json({ ok: false, error: e.message });
  }
}

app.get("/jd/decision", handleJudilibreDecision);
app.get("/getJudilibreDecision", handleJudilibreDecision);

app.post("/raw/request", async (req, res) => {
  try {
    const api = String(req.body?.api || "").trim();
    const method = String(req.body?.method || "GET").toUpperCase();
    const path = String(req.body?.path || "").trim();
    const absoluteUrl = String(req.body?.url || "").trim();
    const query = req.body?.query || {};
    const body = req.body?.body || {};

    if (!absoluteUrl && !["legifrance", "judilibre"].includes(api)) {
      return res.status(400).json({ ok: false, error: "api doit valoir 'legifrance' ou 'judilibre', ou fournissez 'url'" });
    }

    if (!absoluteUrl && !path) {
      return res.status(400).json({ ok: false, error: "path requis" });
    }

    if (absoluteUrl) {
      const token = await getAccessToken();
      const headers = {};
      const init = { method, headers };

      if (!absoluteUrl.startsWith("https://www.legifrance.gouv.fr")) {
        headers.Authorization = `Bearer ${token}`;
      }

      if (method !== "GET" && method !== "HEAD") {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body ?? {});
      }

      const resp = await fetch(absoluteUrl, init);
      const txt = await resp.text();

      let parsed;
      try {
        parsed = JSON.parse(txt);
      } catch {
        parsed = { raw: txt, parseError: true };
      }

      return res.status(resp.status).json({
        ok: resp.ok,
        api_used: api || "absolute_url",
        url_used: absoluteUrl,
        ...parsed
      });
    }

    const baseUrl = api === "legifrance" ? LF_BASE : JD_BASE;

    const out = await upstreamJson({
      baseUrl,
      path: path.startsWith("/") ? path : `/${path}`,
      method,
      query,
      body
    });

    const payload = typeof out.data === "object" && out.data !== null
      ? { ok: out.ok, api_used: api, path_used: path, ...out.data }
      : out.data;

    res.status(out.status).json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy V3.1 LF + JD en écoute sur ${PORT}`);
});
