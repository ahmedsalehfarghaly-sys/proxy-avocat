import express from "express";

const app = express();
app.use(express.json());

const PORT = 3000;

const CLIENT_ID = "5903add5-aaa8-4372-acbc-f16913450ac3";
const CLIENT_SECRET = "acaebcc4-d1f9-4b7d-b518-1307bd05e0d6";

let token = null;
let tokenExpiry = 0;

async function getToken() {
  const now = Date.now();

  if (token && now < tokenExpiry) {
    return token;
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

  const data = await response.json();

  token = data.access_token;
  tokenExpiry = now + ((data.expires_in || 3600) - 60) * 1000;

  return token;
}

async function callPiste(path, method, payload) {
  const accessToken = await getToken();

  const response = await fetch(`https://sandbox-api.piste.gouv.fr${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: payload ? JSON.stringify(payload) : undefined
  });

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/legal/research", async (req, res) => {
  try {
    const question = req.body.question;

    const [texts, cases] = await Promise.all([
      callPiste("/dila/legifrance/lf-engine-app/search", "POST", {
        query: question,
        pageNumber: 0,
        pageSize: 5
      }),
      callPiste("/cassation/judilibre/v1.0/search", "POST", {
        query: question,
        pageNumber: 0,
        pageSize: 5
      })
    ]);

    res.json({
      ok: true,
      question,
      texts,
      cases
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy lancé sur http://localhost:${PORT}`);
});
