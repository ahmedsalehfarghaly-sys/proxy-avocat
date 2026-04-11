import express from "express";

const app = express();
app.use(express.json({ limit: "4mb" }));
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
    text
  };
}

function sendUpstreamResult(res, result) {
  res.status(result.status);
  if (result.contentType) res.setHeader("Content-Type", result.contentType);
  return res.send(result.text);
}

function errorResponse(res, error) {
  return res.status(500).json({
    ok: false,
    error: String(error.message || error)
  });
}

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "proxy-adaptateur-legifrance-judilibre-v2" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/lf/commit", async (_req, res) => {
  try {
    const result = await upstreamRequest({
      api: "legifrance",
      method: "GET",
      path: "/misc/commitId"
    });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/search-simple", async (req, res) => {
  try {
    const {
      terms,
      fond = "ALL",
      pageNumber = 1,
      pageSize = 10,
      operateur = "ET",
      typePagination = "DEFAUT",
      typeChamp = "ALL",
      typeRecherche = "TOUS_LES_MOTS_DANS_UN_CHAMP"
    } = req.body || {};

    if (!terms || !String(terms).trim()) {
      return res.status(400).json({ ok: false, error: "Le champ 'terms' est requis." });
    }

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

    const result = await upstreamRequest({
      api: "legifrance",
      method: "POST",
      path: "/search",
      body
    });

    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/search-structured-safe", async (req, res) => {
  try {
    const {
      fond = "ALL",
      terms,
      pageNumber = 1,
      pageSize = 10,
      operateur = "ET",
      typePagination = "DEFAUT",
      typeChamp = "ALL",
      typeRecherche = "TOUS_LES_MOTS_DANS_UN_CHAMP"
    } = req.body || {};

    if (!terms || !String(terms).trim()) {
      return res.status(400).json({ ok: false, error: "Le champ 'terms' est requis." });
    }

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

    const result = await upstreamRequest({
      api: "legifrance",
      method: "POST",
      path: "/search",
      body
    });

    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/suggest", async (req, res) => {
  try {
    const { query, searchText } = req.body || {};
    const body = {
      searchText: String(searchText || query || "").trim()
    };

    if (!body.searchText) {
      return res.status(400).json({ ok: false, error: "Le champ 'query' ou 'searchText' est requis." });
    }

    const result = await upstreamRequest({
      api: "legifrance",
      method: "POST",
      path: "/suggest",
      body
    });

    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/suggest-acco", async (req, res) => {
  try {
    const { query, searchText } = req.body || {};
    const body = {
      searchText: String(searchText || query || "").trim()
    };

    if (!body.searchText) {
      return res.status(400).json({ ok: false, error: "Le champ 'query' ou 'searchText' est requis." });
    }

    const result = await upstreamRequest({
      api: "legifrance",
      method: "POST",
      path: "/suggest/acco",
      body
    });

    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/article-by-id", async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) {
      return res.status(400).json({ ok: false, error: "Le champ 'id' est requis." });
    }

    const result = await upstreamRequest({
      api: "legifrance",
      method: "POST",
      path: "/consult/getArticleWithIdEliOrAlias",
      body: { id }
    });

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

    const searchBody = {
      fond: "ALL",
      recherche: {
        pageNumber: 1,
        pageSize: 5,
        operateur: "ET",
        typePagination: "DEFAUT",
        champs: [
          {
            typeChamp: "ALL",
            operateur: "ET",
            criteres: [
              {
                valeur: String(terms).trim(),
                operateur: "ET",
                typeRecherche: "EXPRESSION_EXACTE"
              }
            ]
          }
        ]
      }
    };

    const searchResult = await upstreamRequest({
      api: "legifrance",
      method: "POST",
      path: "/search",
      body: searchBody
    });

    return sendUpstreamResult(res, searchResult);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/lf/code-safe", async (req, res) => {
  try {
    const {
      textId,
      date = "2024-01-01",
      abrogated = false,
      searchedString,
      fromSuggest = false,
      sctCid
    } = req.body || {};

    if (!textId) {
      return res.status(400).json({ ok: false, error: "Le champ 'textId' est requis." });
    }

    const body = {
      textId,
      date,
      abrogated,
      fromSuggest
    };

    if (searchedString !== undefined) body.searchedString = searchedString;
    if (sctCid !== undefined) body.sctCid = sctCid;

    const result = await upstreamRequest({
      api: "legifrance",
      method: "POST",
      path: "/consult/code",
      body
    });

    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.get("/jd/search", async (req, res) => {
  try {
    const result = await upstreamRequest({
      api: "judilibre",
      method: "GET",
      path: "/search",
      query: req.query
    });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.get("/jd/scan", async (req, res) => {
  try {
    const result = await upstreamRequest({
      api: "judilibre",
      method: "GET",
      path: "/scan",
      query: req.query
    });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.get("/jd/decision", async (req, res) => {
  try {
    const { id } = req.query || {};
    if (!id) {
      return res.status(400).json({ ok: false, error: "Le paramètre 'id' est requis." });
    }

    const result = await upstreamRequest({
      api: "judilibre",
      method: "GET",
      path: "/decision",
      query: req.query
    });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.post("/raw/request", async (req, res) => {
  try {
    const { api, method = "GET", path = "/", query = {}, body } = req.body || {};

    if (!api || !API_CONFIG[api]) {
      return res.status(400).json({
        ok: false,
        error: "Le champ 'api' est requis et doit valoir 'legifrance' ou 'judilibre'."
      });
    }

    const result = await upstreamRequest({ api, method, path, query, body });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.use("/dila/legifrance/lf-engine-app", async (req, res) => {
  try {
    const result = await upstreamRequest({
      api: "legifrance",
      method: req.method,
      path: req.originalUrl,
      body: req.body
    });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.use("/cassation/judilibre/v1.0", async (req, res) => {
  try {
    const result = await upstreamRequest({
      api: "judilibre",
      method: req.method,
      path: req.originalUrl,
      body: req.body
    });
    return sendUpstreamResult(res, result);
  } catch (error) {
    return errorResponse(res, error);
  }
});

app.listen(PORT, () => {
  console.log(`Proxy corrigé v2 lancé sur http://localhost:${PORT}`);
});
