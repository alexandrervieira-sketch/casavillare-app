// ──────────────────────────────────────────────────────────────────────────
// emitirNota — Camada fiscal provider-agnóstica (Cloudflare Worker)
//
// O CRM fala uma "Nota Canônica" (formato interno, neutro). Esta camada
// traduz para o provedor (Adapter) e normaliza a resposta de volta. Trocar de
// provedor no futuro = trocar/adicionar um adapter, SEM mexer no CRM.
//
//   CRM → emitirNota → [Adapter Focus | outro adapter futuro | …] → Provedor → SEFAZ
//
// Os tokens dos provedores ficam como SECRETS deste Worker (env), nunca no
// navegador nem no Git.
// Rotas:
//   GET  /            → health check
//   POST /emitir      → { ambiente, ref?, nota:<canônica> }  → emite
//   GET  /status?ref=&ambiente= → consulta status por referência
// ──────────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// ── C2: Autenticação (14/07/2026) ───────────────────────────────────────────
// Só chamadas com um Firebase ID token VÁLIDO do projeto e e-mail corporativo
// passam. Antes, qualquer um na internet podia emitir/cancelar NFe. O token é
// verificado por assinatura (RS256) contra as chaves públicas do Firebase.
// FB_PROJECT é o projectId do Firebase (público, não é segredo).
const FB_PROJECT = 'sistema-casa-villare';

let _jwksCache = { keys: null, exp: 0 };
async function _getFirebaseKeys() {
  const now = Date.now();
  if (_jwksCache.keys && now < _jwksCache.exp) return _jwksCache.keys;
  const res = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  const data = await res.json();
  const map = {};
  for (const k of (data.keys || [])) map[k.kid] = k;
  let ttl = 3600;
  const m = (res.headers.get('cache-control') || '').match(/max-age=(\d+)/);
  if (m) ttl = parseInt(m[1], 10);
  _jwksCache = { keys: map, exp: now + Math.max(60, ttl) * 1000 };
  return map;
}
function _b64urlBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function _b64urlJson(s) { return JSON.parse(new TextDecoder().decode(_b64urlBytes(s))); }

async function verifyFirebaseIdToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('token malformado');
  const header = _b64urlJson(parts[0]), payload = _b64urlJson(parts[1]);
  if (header.alg !== 'RS256') throw new Error('alg inválido');
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== FB_PROJECT) throw new Error('aud inválido');
  if (payload.iss !== 'https://securetoken.google.com/' + FB_PROJECT) throw new Error('iss inválido');
  if (!payload.sub) throw new Error('sub ausente');
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new Error('token expirado');
  if (typeof payload.iat !== 'number' || payload.iat > now + 300) throw new Error('iat futuro');
  const keys = await _getFirebaseKeys();
  const jwk = keys[header.kid];
  if (!jwk) throw new Error('kid desconhecido');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, _b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new Error('assinatura inválida');
  return payload;
}
// Exige Bearer válido + e-mail do domínio corporativo. { ok, status?, error? }
async function assertAuth(req) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, error: 'Sem token' };
  try {
    const c = await verifyFirebaseIdToken(m[1]);
    if (!/^[^@]+@casavillare\.com\.br$/i.test(String(c.email || ''))) return { ok: false, status: 403, error: 'E-mail não corporativo' };
    return { ok: true, uid: c.sub, email: c.email, perfil: c.perfil };
  } catch (e) {
    return { ok: false, status: 401, error: 'Token inválido: ' + ((e && e.message) || e) };
  }
}

// ── Provedor: Focus NFe ─────────────────────────────────────────────────────
function focusBase(amb) { return amb === 'producao' ? 'https://api.focusnfe.com.br' : 'https://homologacao.focusnfe.com.br'; }
function focusToken(env, amb) { return amb === 'producao' ? env.FOCUS_PRD : env.FOCUS_HML; }
function focusAuth(token) { return 'Basic ' + btoa(token + ':'); }

// Adapter: Nota Canônica → payload Focus NFe v2
function adapterFocus(nota) {
  const d = nota.destinatario || {};
  const end = d.endereco || {};
  const doc = String(d.cpfCnpj || '').replace(/\D/g, '');
  const isCnpj = doc.length > 11;
  // IE do destinatário (regra SEFAZ; SP NÃO aceita indicador 2 "isento"):
  //   ind 1 = contribuinte com IE  → envia a IE (SP valida que a IE pertence ao CNPJ)
  //   ind 9 = não contribuinte     → não envia IE (PF/consumidor; um CNPJ sem IE será
  //                                   recusado pela SEFAZ pedindo a IE — ela é obrigatória p/ PJ)
  const ieRaw = String(d.inscricaoEstadual || '').trim();
  const ieNum = ieRaw.replace(/\D/g, '');
  const temIE = ieNum.length > 0 && !/isent/i.test(ieRaw);
  const indIE = temIE ? 1 : 9;
  const ieOut = temIE ? ieNum : undefined;
  // Desconto da nota distribuído proporcionalmente entre os itens (último absorve o arredondamento).
  const itens = nota.itens || [];
  const totalBruto = itens.reduce((s, it) => s + (Number(it.valorBruto) || 0), 0);
  const descTotal = Math.round((((nota.totais && nota.totais.valorDesconto) || 0)) * 100) / 100;
  let descAcum = 0;
  const out = {
    natureza_operacao: nota.naturezaOperacao || 'Venda de mercadoria',
    data_emissao: new Date().toISOString(),
    tipo_documento: 1,        // 1 = saída
    finalidade_emissao: 1,    // 1 = normal
    consumidor_final: 1,   // móveis planejados: cliente é consumidor final (não revende)
    presenca_comprador: 1,
    cnpj_emitente: String((nota.emitente && nota.emitente.cnpj) || '').replace(/\D/g, ''),
    nome_destinatario: d.razaoSocial || '',
    indicador_inscricao_estadual_destinatario: indIE,
    inscricao_estadual_destinatario: ieOut,
    logradouro_destinatario: end.logradouro || '',
    numero_destinatario: end.numero || 'S/N',
    bairro_destinatario: end.bairro || '',
    municipio_destinatario: end.municipio || '',
    uf_destinatario: end.uf || '',
    cep_destinatario: String(end.cep || '').replace(/\D/g, ''),
    pais_destinatario: 'Brasil',
    valor_frete: 0,
    modalidade_frete: 9,      // 9 = sem ocorrência de transporte
    informacoes_adicionais_contribuinte: (nota.informacoesAdicionais && nota.informacoesAdicionais.informacoesContribuinte) || undefined,
    items: itens.map((it, i) => {
      const bruto = Number(it.valorBruto) || 0;
      let desconto = 0;
      if (descTotal > 0 && totalBruto > 0) {
        desconto = (i === itens.length - 1) ? Math.round((descTotal - descAcum) * 100) / 100 : Math.round((bruto / totalBruto * descTotal) * 100) / 100;
        descAcum += desconto;
      }
      return {
        numero_item: i + 1,
        codigo_produto: it.codigo || String(i + 1),
        descricao: it.descricao,
        cfop: it.cfop,
        unidade_comercial: it.unidadeComercial || 'UN',
        quantidade_comercial: it.quantidadeComercial || 1,
        valor_unitario_comercial: it.valorUnitarioComercial,
        valor_bruto: it.valorBruto,
        valor_desconto: desconto,
        unidade_tributavel: it.unidadeComercial || 'UN',
        quantidade_tributavel: it.quantidadeComercial || 1,
        valor_unitario_tributavel: it.valorUnitarioComercial,
        codigo_ncm: it.ncm,
        icms_origem: 0,
        icms_situacao_tributaria: it.csosn || '102', // CSOSN (Simples Nacional)
        // PIS/COFINS: obrigatórios no XML. No Simples Nacional o valor é zero (recolhido no DAS).
        pis_situacao_tributaria: it.pisCst || '99',
        pis_aliquota_porcentual: 0,
        pis_valor: 0,
        cofins_situacao_tributaria: it.cofinsCst || '99',
        cofins_aliquota_porcentual: 0,
        cofins_valor: 0,
      };
    }),
  };
  if (isCnpj) out.cnpj_destinatario = doc; else out.cpf_destinatario = doc;
  return out;
}

// Resposta Focus → resultado normalizado (igual para qualquer provedor)
function normalizeFocus(data, amb) {
  const apiBase = focusBase(amb);
  return {
    provider: 'focus',
    status: data.status || '',
    autorizado: data.status === 'autorizado',
    numero: data.numero || '',
    serie: data.serie || '',
    chave: data.chave_nfe || '',
    danfeUrl: data.caminho_danfe ? apiBase + data.caminho_danfe : '',
    xmlUrl: data.caminho_xml_nota_fiscal ? apiBase + data.caminho_xml_nota_fiscal : '',
    mensagem: data.mensagem_sefaz || data.mensagem || '',
    erros: data.erros || [],
    raw: data,
  };
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response('', { headers: CORS });
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'emitirNota', provider: 'focus', ts: Date.now() });
    }

    // C2: todas as rotas (menos o health check acima) exigem Firebase ID token corporativo válido.
    const auth = await assertAuth(req);
    if (!auth.ok) return json({ error: auth.error }, auth.status);

    try {
      if (req.method === 'POST' && url.pathname === '/emitir') {
        const b = await req.json();
        const amb = b.ambiente === 'producao' ? 'producao' : 'homologacao';
        const tok = focusToken(env, amb);
        if (!tok) return json({ error: 'Token Focus não configurado para ' + amb }, 500);
        const ref = b.ref || ('cv' + Date.now());
        const payload = adapterFocus(b.nota || {});
        // Homologação: a SEFAZ EXIGE este nome fixo no destinatário (senão rejeita).
        if (amb === 'homologacao') payload.nome_destinatario = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
        const r = await fetch(focusBase(amb) + '/v2/nfe?ref=' + encodeURIComponent(ref), {
          method: 'POST',
          headers: { 'Authorization': focusAuth(tok), 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await r.json().catch(() => ({}));
        return json({ ref, http: r.status, ...normalizeFocus(data, amb) });
      }

      // Carta de Correção (CC-e): corrige erros de TEXTO de uma nota autorizada (15 a 1000 caracteres).
      if (req.method === 'POST' && url.pathname === '/carta-correcao') {
        const b = await req.json();
        const amb = b.ambiente === 'producao' ? 'producao' : 'homologacao';
        const tok = focusToken(env, amb);
        const ref = b.ref;
        const correcao = String(b.correcao || '').trim();
        if (!ref || !tok) return json({ error: 'ref/token' }, 400);
        if (correcao.length < 15 || correcao.length > 1000) return json({ error: 'A correção deve ter de 15 a 1000 caracteres' }, 400);
        const r = await fetch(focusBase(amb) + '/v2/nfe/' + encodeURIComponent(ref) + '/carta_correcao', {
          method: 'POST',
          headers: { 'Authorization': focusAuth(tok), 'Content-Type': 'application/json' },
          body: JSON.stringify({ correcao }),
        });
        const data = await r.json().catch(() => ({}));
        return json({ http: r.status, ok: r.status >= 200 && r.status < 300, ...normalizeFocus(data, amb) });
      }

      // Cancela uma NFe autorizada (dentro do prazo legal). Exige justificativa de 15 a 255 caracteres.
      if (req.method === 'POST' && url.pathname === '/cancelar') {
        const b = await req.json();
        const amb = b.ambiente === 'producao' ? 'producao' : 'homologacao';
        const tok = focusToken(env, amb);
        const ref = b.ref;
        const justificativa = String(b.justificativa || '').trim();
        if (!ref || !tok) return json({ error: 'ref/token' }, 400);
        if (justificativa.length < 15 || justificativa.length > 255) return json({ error: 'Justificativa deve ter de 15 a 255 caracteres' }, 400);
        const r = await fetch(focusBase(amb) + '/v2/nfe/' + encodeURIComponent(ref), {
          method: 'DELETE',
          headers: { 'Authorization': focusAuth(tok), 'Content-Type': 'application/json' },
          body: JSON.stringify({ justificativa }),
        });
        const data = await r.json().catch(() => ({}));
        return json({ http: r.status, ok: r.status >= 200 && r.status < 300, ...normalizeFocus(data, amb) });
      }

      // Envia o DANFE+XML por e-mail aos destinatários (o Focus anexa e envia do servidor dele).
      if (req.method === 'POST' && url.pathname === '/email') {
        const b = await req.json();
        const amb = b.ambiente === 'producao' ? 'producao' : 'homologacao';
        const tok = focusToken(env, amb);
        const ref = b.ref;
        const emails = (Array.isArray(b.emails) ? b.emails : []).map(e => String(e || '').trim()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
        if (!ref || !tok) return json({ error: 'ref/token' }, 400);
        if (!emails.length) return json({ error: 'Nenhum e-mail válido informado' }, 400);
        const r = await fetch(focusBase(amb) + '/v2/nfe/' + encodeURIComponent(ref) + '/email', {
          method: 'POST',
          headers: { 'Authorization': focusAuth(tok), 'Content-Type': 'application/json' },
          body: JSON.stringify({ emails }),
        });
        const data = await r.json().catch(() => ({}));
        return json({ http: r.status, ok: r.status >= 200 && r.status < 300, enviados: emails, ...data });
      }

      if (req.method === 'GET' && url.pathname === '/status') {
        const ref = url.searchParams.get('ref');
        const amb = url.searchParams.get('ambiente') === 'producao' ? 'producao' : 'homologacao';
        const tok = focusToken(env, amb);
        if (!ref) return json({ error: 'ref obrigatório' }, 400);
        if (!tok) return json({ error: 'Token Focus não configurado para ' + amb }, 500);
        const r = await fetch(focusBase(amb) + '/v2/nfe/' + encodeURIComponent(ref), {
          headers: { 'Authorization': focusAuth(tok) },
        });
        const data = await r.json().catch(() => ({}));
        return json({ ref, http: r.status, ...normalizeFocus(data, amb) });
      }

      // Baixa o arquivo legal (XML autorizado) ou o DANFE (PDF) autenticado no Focus e
      // devolve o conteúdo bruto — o CRM então arquiva no Firebase Storage (guarda de 5 anos).
      if (req.method === 'GET' && url.pathname === '/arquivo') {
        const ref = url.searchParams.get('ref');
        const amb = url.searchParams.get('ambiente') === 'producao' ? 'producao' : 'homologacao';
        const tipo = url.searchParams.get('tipo') === 'danfe' ? 'danfe' : 'xml';
        const tok = focusToken(env, amb);
        if (!ref) return json({ error: 'ref obrigatório' }, 400);
        if (!tok) return json({ error: 'Token Focus não configurado para ' + amb }, 500);
        // 1) consulta a nota para achar o caminho do arquivo
        const r = await fetch(focusBase(amb) + '/v2/nfe/' + encodeURIComponent(ref), { headers: { 'Authorization': focusAuth(tok) } });
        const data = await r.json().catch(() => ({}));
        const path = tipo === 'danfe' ? data.caminho_danfe : data.caminho_xml_nota_fiscal;
        if (!path) return json({ error: 'arquivo ainda não disponível', status: data.status || '' }, 404);
        // 2) baixa o arquivo autenticado e repassa o conteúdo bruto
        const f = await fetch(focusBase(amb) + path, { headers: { 'Authorization': focusAuth(tok) } });
        if (!f.ok) return json({ error: 'falha ao baixar arquivo', http: f.status }, 502);
        const buf = await f.arrayBuffer();
        return new Response(buf, { headers: { ...CORS, 'Content-Type': tipo === 'danfe' ? 'application/pdf' : 'application/xml; charset=utf-8' } });
      }

      return json({ error: 'rota não encontrada' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};
