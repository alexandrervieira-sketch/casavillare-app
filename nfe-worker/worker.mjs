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
  'Access-Control-Allow-Headers': 'Content-Type',
};
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
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
  // Contribuinte de ICMS? (tem IE de verdade, não "Isento"). Define indicador + consumidor final.
  const ieDest = String(d.inscricaoEstadual || '').trim();
  const contribuinte = !!ieDest && !/isent/i.test(ieDest);
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
    consumidor_final: contribuinte ? 0 : 1,   // não contribuinte → consumidor final (exigência SEFAZ)
    presenca_comprador: 1,
    cnpj_emitente: String((nota.emitente && nota.emitente.cnpj) || '').replace(/\D/g, ''),
    nome_destinatario: d.razaoSocial || '',
    indicador_inscricao_estadual_destinatario: contribuinte ? 1 : 9, // 1=contribuinte, 9=não contribuinte
    inscricao_estadual_destinatario: contribuinte ? ieDest : undefined,
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
