// Publica storage.rules no Firebase Storage. Descobre o release de storage sozinho.
//   node _deploy_storage.js          → DRY RUN (só mostra o release alvo, não altera)
//   node _deploy_storage.js --apply  → cria ruleset e aponta o release
// Credencial: env GOOGLE_APPLICATION_CREDENTIALS (mesmo SA do deploy).
const fs = require("fs"), https = require("https"), crypto = require("crypto");
const SA = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8"));
const PROJECT = SA.project_id;
const APPLY = process.argv.includes("--apply");
const RULES = fs.readFileSync("C:/Users/alexa/Desktop/casavillare-sistema/storage.rules", "utf8");
const b64 = b => Buffer.from(b).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
function mintToken() { return new Promise((resolve, reject) => { const now = Math.floor(Date.now() / 1000); const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" })); const clm = b64(JSON.stringify({ iss: SA.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: SA.token_uri, iat: now, exp: now + 3600 })); const si = head + "." + clm; const sig = b64(crypto.createSign("RSA-SHA256").update(si).sign(SA.private_key)); const body = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + si + "." + sig; const u = new URL(SA.token_uri); const req = https.request({ host: u.hostname, path: u.pathname, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }, timeout: 20000 }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject("token: " + d); } catch (e) { reject("token parse " + d); } }); }); req.on("error", reject); req.write(body); req.end(); }); }
function api(method, urlStr, token, bodyObj) { return new Promise((resolve, reject) => { const u = new URL(urlStr); const payload = bodyObj !== undefined ? Buffer.from(JSON.stringify(bodyObj)) : null; const headers = { "Authorization": "Bearer " + token }; if (payload) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = payload.length; } const req = https.request({ host: u.hostname, path: u.pathname + u.search, method, headers, timeout: 60000 }, res => { let c = []; res.on("data", d => c.push(d)); res.on("end", () => { const txt = Buffer.concat(c).toString("utf8"); if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(txt ? JSON.parse(txt) : {}); } catch (e) { resolve(txt); } } else reject("HTTP " + res.statusCode + " " + method + " :: " + txt.slice(0, 500)); }); }); req.on("error", e => reject("REQ_ERR " + e.message)); if (payload) req.write(payload); req.end(); }); }
(async () => {
  try {
    const token = await mintToken(); console.log("Token OK");
    const BASE = "https://firebaserules.googleapis.com/v1";
    // Descobre o release de storage (nome: projects/<p>/releases/firebase.storage/<bucket>)
    const rel = await api("GET", BASE + "/projects/" + PROJECT + "/releases?pageSize=100", token);
    const stor = (rel.releases || []).filter(r => /firebase\.storage/.test(r.name));
    if (!stor.length) throw "Nenhum release firebase.storage encontrado — o Storage foi inicializado no Console?";
    console.log("Releases de storage encontrados:");
    stor.forEach(r => console.log("  " + r.name + "  →  " + (r.rulesetName || "?")));
    if (!APPLY) { console.log("\n*** DRY RUN — nada alterado. Rode com --apply. ***"); return; }
    // Cria o ruleset com o storage.rules atual
    const rs = await api("POST", BASE + "/projects/" + PROJECT + "/rulesets", token, { source: { files: [{ name: "storage.rules", content: RULES }] } });
    console.log("Ruleset criado:", rs.name);
    // Aponta cada release de storage para o novo ruleset
    for (const r of stor) {
      await api("PATCH", BASE + "/" + r.name, token, { release: { name: r.name, rulesetName: rs.name } });
      console.log("Release atualizado:", r.name);
    }
    console.log("REGRAS PUBLICADAS no Storage.");
  } catch (e) { console.error("FALHA: " + e); process.exit(1); }
})();
