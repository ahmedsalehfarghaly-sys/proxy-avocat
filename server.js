{
  "name": "proxy-avocat",
  "version": "4.3.2",
  "description": "Proxy unifié Légifrance + Judilibre pour avocat en contentieux — OAuth2 PISTE, retry, rerankage TEXTE→JUGE→ADMINISTRATION→PROCÉDURE",
  "main": "server.js",
  "type": "commonjs",
  "license": "UNLICENSED",
  "private": true,
  "engines": {
    "node": ">=18.0.0",
    "npm":  ">=9.0.0"
  },
  "scripts": {
    "start":     "node server.js",
    "dev":       "node --watch server.js",
    "dev:env":   "node --env-file=.env --watch server.js",
    "start:env": "node --env-file=.env server.js",
    "lint":      "node --check server.js && echo 'Syntax OK'"
  },
  "dependencies": {
    "cors":    "^2.8.5",
    "express": "^4.21.2"
  },
  "keywords": [
    "legifrance",
    "judilibre",
    "piste",
    "droit",
    "contentieux",
    "proxy"
  ]
}
