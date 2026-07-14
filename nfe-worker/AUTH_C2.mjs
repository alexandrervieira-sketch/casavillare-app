// ─────────────────────────────────────────────────────────────────────────────
// C2 (auditoria 13/07/2026) — Autenticação do Worker de NFe
//
// PROBLEMA: o Worker não valida NENHUMA credencial de entrada + CORS '*'. Qualquer
// pessoa na internet que descubra a URL (está no index.html) pode POST /emitir em
// produção (emite NFe real sob o CNPJ da empresa), POST /cancelar (cancela notas
// autorizadas) e GET /arquivo (baixa XML/DANFE com PII). Proxy fiscal ABERTO.
//
// SOLUÇÃO: o cliente envia o Firebase ID token no header Authorization; o Worker
// VERIFICA a assinatura (RS256 contra as chaves públicas do Firebase), confere
// iss/aud/exp e exige perfil gestor|financeiro. Sem token válido → 401.
//
// ── COMO INTEGRAR ────────────────────────────────────────────────────────────
// 1) No worker.mjs:
//    - cole `verifyFirebaseIdToken` e `assertAuth` abaixo (no topo do módulo);
//    - troque CORS Allow-Origin '*' pelo origin do app (ver CORS_ORIGIN abaixo);
//    - no início do fetch(), DEPOIS do OPTIONS e do health check GET '/', chame:
//         const auth = await assertAuth(req, env);
//         if (!auth.ok) return json({ error: auth.error }, auth.status);
//      (deixe o GET '/' health check público, sem auth).
// 2) Secret do Worker (wrangler):  wrangler secret put FB_PROJECT   → o projectId
//    do Firebase (o mesmo do firebaseConfig no index.html, campo projectId).
// 3) No index.html, TODA chamada ao worker (fetch NFE_PROXY_URL + ...) passa a
//    enviar o header:  'Authorization': 'Bearer ' + (await firebase.auth().currentUser.getIdToken())
//    Ex. helper no cliente:
//         async function _nfeAuthHeaders(){
//           const u = firebase.auth().currentUser;
//           const t = u ? await u.getIdToken() : '';
//           return { 'Content-Type':'application/json', 'Authorization':'Bearer '+t };
//         }
//    e usar headers: await _nfeAuthHeaders() nos fetch de /emitir, /cancelar,
//    /carta-correcao, /status, /arquivo, /email.
// 4) Deploy do worker (node _deploy_worker.js).
// ─────────────────────────────────────────────────────────────────────────────

// Origin do app (Firebase Hosting). Ajuste se o domínio for outro.
export const CORS_ORIGIN = 'https://casavillare-app.web.app';

// Perfis autorizados a operar a camada fiscal.
const PERFIS_FISCAIS = ['gestor', 'financeiro'];

// Cache das chaves públicas do Firebase (JWKS), respeitando o max-age do header.
let _jwksCache = { keys: null, exp: 0 };
async function _getFirebaseKeys() {
  const now = Date.now();
  if (_jwksCache.keys && now < _jwksCache.exp) return _jwksCache.keys;
  const res = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  const data = await res.json();
  const map = {};
  for (const k of (data.keys || [])) map[k.kid] = k;
  // TTL a partir do Cache-Control (fallback 1h).
  let ttl = 3600;
  const cc = res.headers.get('cache-control') || '';
  const m = cc.match(/max-age=(\d+)/);
  if (m) ttl = parseInt(m[1], 10);
  _jwksCache = { keys: map, exp: now + Math.max(60, ttl) * 1000 };
  return map;
}

function _b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function _b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(_b64urlToBytes(s)));
}

// Verifica um Firebase ID token. Retorna o payload (claims) se válido, senão lança.
export async function verifyFirebaseIdToken(token, projectId) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('token malformado');
  const header = _b64urlToJson(parts[0]);
  const payload = _b64urlToJson(parts[1]);
  if (header.alg !== 'RS256') throw new Error('alg inválido');

  // Claims obrigatórias do Firebase Auth.
  const now = Math.floor(Date.now() / 1000);
  const iss = 'https://securetoken.google.com/' + projectId;
  if (payload.aud !== projectId) throw new Error('aud inválido');
  if (payload.iss !== iss) throw new Error('iss inválido');
  if (!payload.sub) throw new Error('sub ausente');
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new Error('token expirado');
  if (typeof payload.iat !== 'number' || payload.iat > now + 300) throw new Error('iat futuro');

  // Assinatura RS256 contra a chave pública do kid.
  const keys = await _getFirebaseKeys();
  const jwk = keys[header.kid];
  if (!jwk) throw new Error('kid desconhecido');
  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const sig = _b64urlToBytes(parts[2]);
  const signed = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, signed);
  if (!ok) throw new Error('assinatura inválida');
  return payload;
}

// Gate de autorização para o handler. Exige Bearer válido + perfil fiscal + e-mail corporativo.
export async function assertAuth(req, env) {
  const projectId = env.FB_PROJECT;
  if (!projectId) return { ok: false, status: 500, error: 'FB_PROJECT não configurado' };
  const authz = req.headers.get('Authorization') || '';
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, error: 'Sem token' };
  try {
    const claims = await verifyFirebaseIdToken(m[1], projectId);
    const email = String(claims.email || '');
    if (!/^[^@]+@casavillare\.com\.br$/i.test(email)) return { ok: false, status: 403, error: 'E-mail não corporativo' };
    if (!PERFIS_FISCAIS.includes(claims.perfil)) return { ok: false, status: 403, error: 'Perfil sem permissão fiscal' };
    return { ok: true, uid: claims.sub, email, perfil: claims.perfil };
  } catch (e) {
    return { ok: false, status: 401, error: 'Token inválido: ' + ((e && e.message) || e) };
  }
}
