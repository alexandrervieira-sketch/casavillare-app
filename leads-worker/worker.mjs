// ──────────────────────────────────────────────────────────────────────────
// cv-leads — Ponte de entrada de leads (IA de pré-atendimento → CRM Casa Villare)
//
// A IA (WhatsApp) faz POST /lead com o lead qualificado; este worker traduz para o
// formato do CRM, faz o RODÍZIO de vendedores e grava direto no Firestore (coleção
// `leads`, formato {id, _json}), do jeito que o app espera. O app pega em tempo real.
//
// Provider-agnóstico: qualquer IA (a de hoje ou a própria no futuro) que saiba fazer
// POST autenticado plugga aqui, sem mexer no CRM.
//
// SECRETS (env do worker):
//   API_KEY  → chave que a IA envia em Authorization: Bearer <API_KEY>
//   FB_SA    → JSON da service account do Firebase (para gravar no Firestore)
//
// Rotas:
//   GET  /        → health check (público)
//   POST /lead    → cria o lead (exige Bearer API_KEY)
// ──────────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// ── OAuth token do Google a partir da service account (assina JWT RS256 via WebCrypto) ──
function _b64url(str) { return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function _b64urlBytes(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
async function _importKey(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}
let _tokCache = { tok: null, exp: 0 };
async function getToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (_tokCache.tok && now < _tokCache.exp - 60) return _tokCache.tok;
  const header = _b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = _b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: sa.token_uri, iat: now, exp: now + 3600 }));
  const unsigned = header + '.' + claim;
  const key = await _importKey(sa.private_key);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const jwt = unsigned + '.' + _b64urlBytes(sig);
  const res = await fetch(sa.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt });
  const j = await res.json();
  if (!j.access_token) throw new Error('token: ' + JSON.stringify(j).slice(0, 200));
  _tokCache = { tok: j.access_token, exp: now + 3600 };
  return j.access_token;
}
function fsBase(sa) { return 'https://firestore.googleapis.com/v1/projects/' + sa.project_id + '/databases/(default)/documents'; }

// ── Rodízio: lê _config/leadRodizio, incrementa o idx atômico e devolve o próximo vendedor ──
async function proximoVendedor(sa, token) {
  // Lê a config (ativo, disponiveis). Se não existe/inativa/vazia → sem responsável (distribuição manual).
  let cfg = null;
  try {
    const r = await fetch(fsBase(sa) + '/_config/leadRodizio', { headers: { Authorization: 'Bearer ' + token } });
    if (r.ok) cfg = await r.json();
  } catch (e) {}
  const f = (cfg && cfg.fields) || {};
  const ativo = f.ativo && f.ativo.booleanValue === true;
  const disp = (f.disponiveis && f.disponiveis.arrayValue && f.disponiveis.arrayValue.values || []).map(v => v.stringValue).filter(Boolean);
  if (!ativo || !disp.length) return '';
  // Incremento ATÔMICO do idx (transform) — garante que dois leads simultâneos nunca caem no mesmo vendedor.
  const body = { writes: [{ transform: { document: fsBase(sa).replace('https://firestore.googleapis.com/v1/', '') + '/_config/leadRodizio', fieldTransforms: [{ fieldPath: 'idx', increment: { integerValue: '1' } }] } }] };
  let novoIdx = 0;
  try {
    const r = await fetch(fsBase(sa) + ':commit', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    novoIdx = parseInt(j.writeResults && j.writeResults[0] && j.writeResults[0].transformResults && j.writeResults[0].transformResults[0] && j.writeResults[0].transformResults[0].integerValue || '0', 10);
  } catch (e) { return disp[0]; }
  const i = ((novoIdx - 1) % disp.length + disp.length) % disp.length;
  return disp[i] || disp[0];
}

// ── Mapeia a origem enviada pela IA para as chaves do CRM ──
function mapOrigem(o) {
  const s = String(o || '').toLowerCase().trim();
  if (/recompra/.test(s)) return 'recompra';
  if (/an[uú]ncio|tr[aá]fego|\bads?\b|meta ads|google ads/.test(s)) return 'trafego';
  if (/indica/.test(s)) return 'indicacao';
  if (/instagram|\binsta\b/.test(s)) return 'instagram';
  if (/\bsite\b/.test(s)) return 'site';
  if (/loja/.test(s)) return 'loja';
  if (/\bbni\b/.test(s)) return 'bni';
  return 'outro';
}
function _hojeBR() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); } // data local (BRT = UTC-3)
function _txt(v) { return (v == null ? '' : String(v)).trim(); }
// Id determinístico (só dígitos) a partir de uma chave de idempotência — reenvio gera o MESMO id (não duplica).
async function _idFromKey(key) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  let n = 0n; for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(h[i]);
  return n.toString();
}
// Resolve a chave de API → nome do CANAL. Suporta múltiplas chaves (env API_KEYS = JSON chave:canal)
// ou uma única (env API_KEY → canal "ia"). '' = não autorizado.
function _canalDaChave(env, key) {
  if (!key) return '';
  if (env.API_KEYS) { try { const mp = JSON.parse(env.API_KEYS); if (mp[key]) return mp[key]; } catch (e) {} }
  if (env.API_KEY && key === env.API_KEY) return 'ia';
  return '';
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'cv-leads', ts: Date.now() });
    }
    if (req.method !== 'POST' || url.pathname !== '/lead') return json({ error: 'rota não encontrada' }, 404);

    // Auth: Bearer contra uma ou várias chaves; resolve o CANAL (qual IA enviou).
    const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
    const canal = _canalDaChave(env, m && m[1]);
    if (!canal) return json({ error: 'Não autorizado' }, 401);

    let b;
    try { b = await req.json(); } catch (e) { return json({ error: 'JSON inválido' }, 400); }
    const nome = _txt(b.nome), telefone = _txt(b.telefone).replace(/\D/g, '');
    if (!nome) return json({ error: 'Campo obrigatório: nome' }, 400);
    if (!telefone) return json({ error: 'Campo obrigatório: telefone' }, 400);

    let sa;
    try { sa = typeof env.FB_SA === 'string' ? JSON.parse(env.FB_SA) : env.FB_SA; } catch (e) { return json({ error: 'FB_SA inválido' }, 500); }

    try {
      const token = await getToken(sa);
      const responsavel = await proximoVendedor(sa, token);

      // Resumo estruturado nas Observações (nada se perde)
      const obsLinhas = [];
      if (_txt(b.resumo)) obsLinhas.push('📝 Resumo (IA):\n' + _txt(b.resumo));
      const extra = [];
      if (_txt(b.tipoImovel)) extra.push('Tipo de imóvel: ' + _txt(b.tipoImovel));
      if (_txt(b.statusProjeto)) extra.push('Status do projeto: ' + _txt(b.statusProjeto));
      if (_txt(b.finalidade)) extra.push('Finalidade: ' + _txt(b.finalidade));
      if (_txt(b.investimentoEstimado)) extra.push('Investimento estimado: ' + _txt(b.investimentoEstimado));
      if (_txt(b.captadoEm)) extra.push('Captado em: ' + _txt(b.captadoEm));
      if (extra.length) obsLinhas.push(extra.join('\n'));
      obsLinhas.push('— via IA de pré-atendimento (WhatsApp)');

      // Id: com idempotencyKey → determinístico (reenvio não duplica); sem → aleatório. Sempre só dígitos (o app usa _sid).
      const idem = _txt(b.idempotencyKey);
      const id = idem ? await _idFromKey(idem) : (String(Date.now()) + String(Math.floor(Math.random() * 1000000)).padStart(6, '0'));
      const dataCriacao = _txt(b.captadoEm) ? _txt(b.captadoEm).slice(0, 10) : _hojeBR();
      const lead = {
        id, nome, _uAt: Date.now(),
        telefone, email: '', cidade: _txt(b.cidade),
        origem: mapOrigem(b.origem), responsavel,
        etapa: 'atendimento', status: 'ativo',
        valor: 0, desconto: 0, taxaLoja: 0, taxaCli: 0, parcelas: 0, absorcao: 'cliente', condicoesPgto: null,
        proxContato: '',
        ambiente: _txt(b.ambientes), metragem: '', estilo: '',
        prazo: _txt(b.prazo), prazoEntrega: '', tipoVenda: '', especificadorId: '', rtPct: 0,
        orcamento: '', obs: obsLinhas.join('\n\n'), tags: '',
        dataCriacao, dataFechamento: null,
        _origemIA: true,      // veio da integração — o app mostra selo e checa "já registrado" por telefone
        _canalOrigem: canal,  // qual IA/canal enviou (ex.: "ia-whatsapp" hoje, "ia-propria" no futuro) — comparação de desempenho
      };

      // Grava o lead em leads/<id> = {id, _json}
      const r = await fetch(fsBase(sa) + '/leads/' + id, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { id: { stringValue: id }, _json: { stringValue: JSON.stringify(lead) } } }),
      });
      if (!r.ok) { const t = await r.text(); return json({ error: 'falha ao gravar', detalhe: t.slice(0, 200) }, 502); }

      return json({ ok: true, leadId: id, responsavel: responsavel || '(não atribuído)' }, 201);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};
