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
  if (!CLIENT_ID || CLIENT_ID === "REPLACE_ME_CLIENT_ID") {
    throw new Error("CLIENT_ID manquant");
  }
  if (!CLIENT_SECRET || CLIENT_SECRET === "REPLACE_ME_CLIENT_SECRET") {
    throw new Error("CLIENT_SECRET manquant");
  }
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
  if (!response.ok) {
    throw new Error(`Token error ${response.status}: ${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Réponse token non JSON");
  }

  if (!data.access_token) {
    throw new Error("Réponse token invalide: access_token absent");
  }

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

  return {
    ok: response.ok,
    status: response.status,
    contentType,
    text,
    json: (() => {
      try { return JSON.parse(text); } catch { return null; }
    })()
  };
}

function sendUpstreamResult(res, result) {
  res.status(result.status);
  if (result.contentType) res.setHeader("Content-Type", result.contentType);
  return res.send(result.text);
}

function errorResponse(res, error) {
  return res.status(500).json({ ok: false, error: String(error.message || error) });
}

function extractResultsArray(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.documents)) return payload.documents;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function deepFindFirstString(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    if (typeof obj[key] === "string" && obj[key].trim()) return obj[key].trim();
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      const found = deepFindFirstString(value, keys);
      if (found) return found;
    }
  }
  return null;
}

function collectCandidateArticleIds(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectCandidateArticleIds(item, out);
    return out;
  }
  const candidateKeys = ["id", "cid", "articleId", "articleCid", "idArticle", "cidArticle", "idEli", "eli", "alias", "articleEli"];
  for (const key of candidateKeys) {
    const v = node[key];
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") collectCandidateArticleIds(value, out);
  }
  return out;
}

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

async function lfSearchStructured({ fond = "ALL", terms, pageNumber = 1, pageSize = 10, operateur = "ET", typePagination = "DEFAUT", typeChamp = "ALL", typeRecherche = "TOUS_LES_MOTS_DANS_UN_CHAMP" }) {
  const body = {
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

  return upstreamRequest({
    api: "legifrance",
    method: "POST",
    path: "/search",
    body
  });
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

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "proxy-adaptateur-legifrance-judilibre-v3" });
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
    const { terms, fond = "ALL", pageNumber = 1, pageSize = 10, operateur = "ET", typePagination = "DEFAUT", typeChamp = "ALL", typeRecherche = "TOUS_LES_MOTS_DANS_UN_CHAMP" } = req.body || {};
    if (!terms || !String(terms).trim()) {
      return res.status(400).json({ ok: false, error: "Le champ 'terms' est requis." });
    }
    const result = await lfSearchStructured({ fond, terms, pageNumber, pageSize, operateur, typePagination, typeChamp, typeRecherche });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/search-structured-safe", async (req, res) => {
  try {
    const { fond = "ALL", terms, pageNumber = 1, pageSize = 10, operateur = "ET", typePagination = "DEFAUT", typeChamp = "ALL", typeRecherche = "TOUS_LES_MOTS_DANS_UN_CHAMP" } = req.body || {};
    if (!terms || !String(terms).trim()) {
      return res.status(400).json({ ok: false, error: "Le champ 'terms' est requis." });
    }
    const result = await lfSearchStructured({ fond, terms, pageNumber, pageSize, operateur, typePagination, typeChamp, typeRecherche });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/suggest", async (req, res) => {
  try {
    const { query, searchText } = req.body || {};
    const body = { searchText: String(searchText || query || "").trim() };
    if (!body.searchText) {
      return res.status(400).json({ ok: false, error: "Le champ 'query' ou 'searchText' est requis." });
    }
    const result = await upstreamRequest({ api: "legifrance", method: "POST", path: "/suggest", body });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/suggest-acco", async (req, res) => {
  try {
    const { query, searchText } = req.body || {};
    const body = { searchText: String(searchText || query || "").trim() };
    if (!body.searchText) {
      return res.status(400).json({ ok: false, error: "Le champ 'query' ou 'searchText' est requis." });
    }
    const result = await upstreamRequest({ api: "legifrance", method: "POST", path: "/suggest/acco", body });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/article-by-id", async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: "Le champ 'id' est requis." });
    const result = await lfGetArticleByIdOrAlias({ id });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/article-resolve", async (req, res) => {
  try {
    const { terms } = req.body || {};
    if (!terms || !String(terms).trim()) {
      return res.status(400).json({ ok: false, error: "Le champ 'terms' est requis." });
    }
    const result = await lfSearchStructured({ fond: "ALL", terms, pageNumber: 1, pageSize: 10, operateur: "ET", typePagination: "DEFAUT", typeChamp: "ALL", typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP" });
    return sendUpstreamResult(res, result);
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

    const codeSearch = await lfSearchStructured({
      fond: "CODE_ETAT",
      terms: String(codeTerms).trim(),
      pageNumber: 1,
      pageSize: 5,
      operateur: "ET",
      typePagination: "DEFAUT",
      typeChamp: "TITLE",
      typeRecherche: "EXPRESSION_EXACTE"
    });

    if (!codeSearch.ok || !codeSearch.json) return sendUpstreamResult(res, codeSearch);

    const codeResults = extractResultsArray(codeSearch.json);
    const codeFirst = codeResults[0];
    if (!codeFirst) {
      return res.status(404).json({ ok: false, error: "Aucun code trouvé pour cette référence." });
    }

    const textId = deepFindFirstString(codeFirst, ["textId", "id", "cid", "cidTexte", "idTexte"]) || null;
    if (!textId) {
      return res.status(404).json({ ok: false, error: "Identifiant de code introuvable dans le résultat." });
    }

    const toc = await lfLegiTableMatieres({ textId, date, nature: "CODE" });
    if (!toc.ok || !toc.json) return sendUpstreamResult(res, toc);

    const articleIds = uniq(collectCandidateArticleIds(toc.json)).filter(v => v.includes("LEGI") || v.startsWith("LEGI") || v.startsWith("JORF") || v.startsWith("KALI"));
    const articleMatch = articleIds.find(v => v.includes(String(articleNumber).replace(/\s+/g, ""))) || articleIds[0] || null;

    return res.json({
      ok: true,
      resolvedTextId: textId,
      candidateArticleIds: articleIds.slice(0, 50),
      suggestedArticleId: articleMatch,
      rawTableMatieres: toc.json
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/article-fetch", async (req, res) => {
  try {
    const { cid, id, date = "2024-01-01" } = req.body || {};
    if (!cid && !id) {
      return res.status(400).json({ ok: false, error: "Le champ 'cid' ou 'id' est requis." });
    }

    if (cid) {
      const byCid = await lfGetArticleByCid({ cid, date });
      return sendUpstreamResult(res, byCid);
    }

    const canonical = await lfCanonicalArticleVersion({ id, date });
    if (canonical.ok && canonical.json) {
      const canonicalCid = deepFindFirstString(canonical.json, ["cid", "articleCid"]);
      if (canonicalCid) {
        const byCid = await lfGetArticleByCid({ cid: canonicalCid, date });
        return sendUpstreamResult(res, byCid);
      }
    }

    const result = await lfGetArticleByIdOrAlias({ id });
    return sendUpstreamResult(res, result);
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

    const result = await upstreamRequest({ api: "legifrance", method: "POST", path: "/consult/code", body });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/code-resolve", async (req, res) => {
  try {
    const { textId, date = "2024-01-01", nature = "CODE" } = req.body || {};
    if (!textId) return res.status(400).json({ ok: false, error: "Le champ 'textId' est requis." });

    const canonical = await lfCanonicalVersion({ textId, date });
    const toc = await lfLegiTableMatieres({ textId, date, nature });

    return res.json({
      ok: true,
      canonicalStatus: canonical.status,
      canonical: canonical.json || canonical.text,
      tableMatieresStatus: toc.status,
      tableMatieres: toc.json || toc.text
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
  console.log(`Proxy corrigé v3 lancé sur http://localhost:${PORT}`);
});
