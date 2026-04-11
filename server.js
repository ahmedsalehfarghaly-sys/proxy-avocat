import express from "express";

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.CLIENT_ID || "5903add5-aaa8-4372-acbc-f16913450ac3";
const CLIENT_SECRET = process.env.CLIENT_SECRET || "acaebcc4-d1f9-4b7d-b518-1307bd05e0d6";

let accessToken = null;
let tokenExpiry = 0;

async function getToken() {
  const now = Date.now();

  if (accessToken && now < tokenExpiry) {
    return accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: "openid"
  });

  const response = await fetch("https://sandbox-oauth.piste.gouv.fr/api/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token error ${response.status}: ${text}`);
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error("Token error: access_token manquant");
  }

  accessToken = data.access_token;
  tokenExpiry = now + ((data.expires_in || 3600) - 60) * 1000;

  return accessToken;
}

async function forwardAbsolutePath(req, res, absolutePathWithQuery) {
  try {
    const token = await getToken();

    const targetUrl = `https://sandbox-api.piste.gouv.fr${absolutePathWithQuery}`;

    const headers = {
      Authorization: `Bearer ${token}`
    };

    const method = req.method.toUpperCase();
    let body;

    if (method !== "GET" && method !== "HEAD") {
      headers["Content-Type"] = "application/json";
      body = Object.keys(req.body || {}).length ? JSON.stringify(req.body) : undefined;
    }

    const response = await fetch(targetUrl, {
      method,
      headers,
      body
    });

    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();

    res.status(response.status);

    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }

    return res.send(text);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: String(error.message || error)
    });
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/dila/legifrance/lf-engine-app", async (req, res) => {
  return forwardAbsolutePath(req, res, req.originalUrl);
});

app.use("/cassation/judilibre/v1.0", async (req, res) => {
  return forwardAbsolutePath(req, res, req.originalUrl);
});

app.listen(PORT, () => {
  console.log(`Proxy complet lancé sur http://localhost:${PORT}`);
});
