// ──────────────────────────────────────────────────────────────────────────
// Testes automatizados — Casa Villare (lógica crítica)
//
// ZERO impacto na produção: lê o JS REAL do index.html, executa num sandbox
// (vm) com stubs de navegador, e testa as funções de lógica pura (sync/
// tombstone/conflito, comissão, valor de venda, config). Testa o código de
// PRODUÇÃO, não cópias.
//
// Uso:  node tests/run-tests.js     (sai com código 1 se algum teste falhar)
// ──────────────────────────────────────────────────────────────────────────
const fs = require('fs'), vm = require('vm'), path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
// Extrai o(s) <script> inline (sem src)
const re = /<script(\b[^>]*)>([\s\S]*?)<\/script>/gi;
let m, js = '';
while ((m = re.exec(HTML))) { if (/\bsrc\s*=/i.test(m[1])) continue; js += '\n' + m[2]; }
if (!js.trim()) { console.error('Não encontrei script inline no index.html'); process.exit(1); }

// ── Stubs de navegador ──────────────────────────────────────────────────────
function makeEl() {
  return new Proxy(function () {}, {
    get(t, p) {
      if (p === 'style') return new Proxy({}, { get: () => '', set: () => true });
      if (p === 'classList') return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      if (p === 'dataset') return {};
      if (p === 'value' || p === 'textContent' || p === 'innerHTML' || p === 'innerText') return '';
      if (p === 'checked' || p === 'disabled') return false;
      if (p === 'files' || p === 'options' || p === 'children') return [];
      if (p === 'parentNode' || p === 'nextElementSibling' || p === 'firstChild' || p === 'parentElement') return makeEl();
      if (p === Symbol.toPrimitive) return () => '';
      return (...a) => makeEl();
    },
    set() { return true; },
    apply() { return makeEl(); },
  });
}
const documentStub = {
  getElementById: () => makeEl(), querySelector: () => makeEl(), querySelectorAll: () => [],
  createElement: () => makeEl(), createTextNode: () => makeEl(),
  body: makeEl(), documentElement: makeEl(), head: makeEl(),
  addEventListener() {}, removeEventListener() {},
};
const localStore = (() => { const o = {}; return { getItem: k => (k in o ? o[k] : null), setItem: (k, v) => { o[k] = String(v); }, removeItem: k => { delete o[k]; }, clear: () => { for (const k in o) delete o[k]; } }; })();
const navigatorStub = { serviceWorker: { getRegistration: () => Promise.resolve(null), register: () => Promise.resolve(), ready: Promise.resolve() }, userAgent: 'node', onLine: true };

let _confirmReturn = true, _confirmCalls = 0;

const ctx = {
  console, JSON, Math, Date, Array, Object, String, Number, Boolean, RegExp, Promise, Set, Map, WeakMap, Symbol,
  parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: () => 0, requestIdleCallback: () => 0,
  document: documentStub, localStorage: localStore, navigator: navigatorStub,
  alert: () => {}, prompt: () => null, confirm: () => { _confirmCalls++; return _confirmReturn; },
  fetch: () => Promise.resolve({ ok: false, status: 0, json: () => Promise.resolve({}) }),
  indexedDB: { open: () => ({}) },
  firebase: undefined, Chart: function () { return { destroy() {} }; },
  URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
  Blob: function () {}, FileReader: function () { this.readAsDataURL = () => {}; },
  performance: { now: () => 0 },
  location: { reload() {}, href: '' },
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
};
ctx.window = ctx; ctx.self = ctx;
vm.createContext(ctx);

// Epílogo: roda no MESMO escopo do script → enxerga ST e as funções (let/function)
const EPILOGUE = `;try{ globalThis.__T = {
  ST: ST,
  _leadValorVenda, _pedValorVendaCRM, _pedidoValorBase, _calcComVendaPontos, _aplicarMargemErro,
  _vendaLiquido, _valorLiquidoVenda,
  _tombKey, _tombAdd, _tombHas, _tombClear, _tombMergeIncoming, _conflCapture, _conflOk, _fsConfigDocs, _diasNaEtapa, _newId
}; }catch(e){ globalThis.__T_ERR = String(e && e.stack || e); }`;

try { vm.runInContext(js + EPILOGUE, ctx, { filename: 'index.inline.js' }); }
catch (e) { console.error('Falha ao avaliar o script do index.html:', e.message); }
if (ctx.__T_ERR) { console.error('Epílogo falhou (símbolo inexistente?):', ctx.__T_ERR); process.exit(1); }
const T = ctx.__T;
if (!T) { console.error('Não capturei as funções (__T indefinido) — o topo do script deve ter lançado erro.'); process.exit(1); }

// ── mini-framework ──────────────────────────────────────────────────────────
let pass = 0, fail = 0; const fails = [];
function test(name, fn) { try { fn(); pass++; } catch (e) { fail++; fails.push(name + ' :: ' + e.message); } }
function assert(c, msg) { if (!c) throw new Error(msg || 'assert falhou'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' — esperado ' + JSON.stringify(b) + ', obteve ' + JSON.stringify(a)); }

// ════════════════ TESTES ════════════════

// Valor de venda = valor ao cliente (com desconto)
test('leadValorVenda aplica desconto', () => assertEq(T._leadValorVenda({ valor: 1000, desconto: 10 }), 900));
test('leadValorVenda sem desconto', () => assertEq(T._leadValorVenda({ valor: 2000, desconto: 0 }), 2000));
test('leadValorVenda lead nulo = 0', () => assertEq(T._leadValorVenda(null), 0));

// Comissão — pontos por desconto (fórmula fixa 3.0 − (desc/10)*0.3)
test('comVendaPontos desc 0 = 3.0', () => assertEq(T._calcComVendaPontos(0).pontos, 3.0));
test('comVendaPontos desc 10 = 2.7', () => assertEq(T._calcComVendaPontos(10).pontos, 2.7));
test('comVendaPontos clamp em 40%', () => assert(T._calcComVendaPontos(999).pontos === T._calcComVendaPontos(40).pontos, 'deveria limitar em 40%'));

// Base de comissão sem margem de erro e sem lead = valor cheio
test('pedidoValorBase sem lead = valor', () => { T.ST.configsCom = {}; assertEq(T._pedidoValorBase({ valor: 1000 }), 1000); });

// Fonte ÚNICA do valor líquido da venda = base de comissão de TODOS (− desconto − taxa − RT)
const _close = (a, b) => Math.abs(a - b) < 0.01;
test('valorLiquidoVenda só desconto', () => assert(_close(T._valorLiquidoVenda({ valor: 50000, desconto: 10 }), 45000), 'aposDesc'));
test('valorLiquidoVenda RT sem desconto', () => assert(_close(T._valorLiquidoVenda({ valor: 50000, rtPct: 3 }), 48500), '50000 − 1500'));
test('valorLiquidoVenda desconto + RT', () => assert(_close(T._valorLiquidoVenda({ valor: 50000, desconto: 10, rtPct: 3 }), 43650), '45000 − 1350'));
test('vendaLiquido detalha taxa/rt/liquido', () => {
  const r = T._vendaLiquido({ valor: 50000, desconto: 10, rtPct: 3 });
  assert(_close(r.aposDesc, 45000) && _close(r.taxa, 0) && _close(r.rt, 1350) && _close(r.liquido, 43650), 'breakdown');
});
// Cascata desconto→taxa→RT (exemplo exato do gestor): 200k −20% −16% −10% = 120.960
test('vendaLiquido em cascata (desconto→taxa→RT)', () => {
  const r = T._vendaLiquido({ valor: 200000, desconto: 20, absorcao: 'loja', taxaLoja: 16, rtPct: 10 });
  assert(_close(r.aposDesc, 160000), 'após desconto = 160.000');
  assert(_close(r.taxa, 25600), 'taxa 16% de 160.000 = 25.600');
  assert(_close(r.rt, 13440), 'RT 10% de 134.400 = 13.440');
  assert(_close(r.liquido, 120960), 'líquido final = 120.960');
});
test('vendaLiquido lead nulo = zeros', () => { const r = T._vendaLiquido(null); assertEq(r.liquido, 0); });

// Tombstones (exclusão durável)
test('tombstone add/has/clear', () => {
  T.ST._tomb = {};
  T._tombAdd('leads', '5'); assert(T._tombHas('leads', '5'), 'has após add');
  T._tombClear('leads', '5'); assert(!T._tombHas('leads', '5'), 'sem marca após clear');
});
// União do _tomb entre máquinas: NUNCA sobrescreve; mantém exclusões das duas e a ação mais recente vence.
test('tomb união preserva exclusão de outra máquina', () => {
  T.ST._tomb = {};
  T._tombAdd('leads', 'arthur');                 // esta máquina excluiu o Arthur
  T._tombMergeIncoming({ 'leads/jarbas': Date.now() }); // chega exclusão da máquina da Paula (Jarbas)
  assert(T._tombHas('leads', 'arthur'), 'exclusão local sobrevive à união');
  assert(T._tombHas('leads', 'jarbas'), 'exclusão remota é incorporada');
});
test('tomb união: recriação recente vence exclusão antiga', () => {
  T.ST._tomb = {};
  // outra máquina ainda tem um tombstone ANTIGO de um evento que aqui foi reagendado depois
  const antigo = Date.now() - 10000;
  T.ST._tomb['eventos/agc_9'] = antigo;           // tombstone antigo (positivo)
  T._tombClear('eventos', 'agc_9');               // reagendado AGORA (negativo, mais recente)
  T._tombMergeIncoming({ 'eventos/agc_9': antigo }); // a máquina antiga reenvia o tombstone velho
  assert(!T._tombHas('eventos', 'agc_9'), 'recriação recente vence: evento NÃO ressuscita o tombstone');
});
test('tomb união: exclusão mais nova vence recriação antiga', () => {
  T.ST._tomb = {};
  T.ST._tomb['leads/x'] = -(Date.now() - 10000);  // recriação antiga
  T._tombMergeIncoming({ 'leads/x': Date.now() }); // exclusão nova de outra máquina
  assert(T._tombHas('leads', 'x'), 'exclusão mais recente prevalece');
});

// Baixa de parcela: id de 19 dígitos NÃO pode ser casado via parseInt/Number (perde precisão).
// Guarda contra a regressão da baixa em massa que nunca encontrava a parcela.
test('id de 19 dígitos: parseInt corrompe, String casa', () => {
  const id = T._newId(); // string de 19 dígitos
  const conds = [{ id, pago: false }];
  // jeito ERRADO (o bug): coagir para Number e comparar estrito
  assert(conds.find(x => x.id === parseInt(id)) === undefined, 'parseInt+=== NÃO deve encontrar (documenta o bug)');
  // jeito CERTO (a correção): comparar como string
  assert(conds.find(x => String(x.id) === String(id)) !== undefined, 'String===String encontra a parcela');
});

// Concorrência (detecção de conflito)
test('conflito: sem mudança → ok, sem pedir confirmação', () => {
  T.ST.leads = [{ id: '1', _uAt: 100 }]; T._conflCapture('leads', T.ST.leads, '1');
  _confirmCalls = 0; const r = T._conflOk('leads', T.ST.leads, '1', 'lead');
  assertEq(r, true, 'sem conflito retorna true'); assertEq(_confirmCalls, 0, 'não chama confirm');
});
test('conflito: registro alterado → pede confirmação', () => {
  T.ST.leads = [{ id: '1', _uAt: 100 }]; T._conflCapture('leads', T.ST.leads, '1');
  T.ST.leads[0]._uAt = 200; _confirmCalls = 0; _confirmReturn = false;
  const r = T._conflOk('leads', T.ST.leads, '1', 'lead');
  assertEq(_confirmCalls, 1, 'chama confirm no conflito'); assertEq(r, false, 'retorna a resposta do confirm');
});

// _fsConfigDocs: inclui _uAt, exclui o relógio local e as coleções
test('fsConfigDocs inclui _uAt e exclui relógio/coleções', () => {
  T.ST.metas = { x: 1 }; T.ST._cfgUAt = { metas: 555 }; T.ST.leads = [{ id: '1' }];
  const docs = T._fsConfigDocs();
  const dm = docs.find(d => d.id === 'metas');
  assert(dm, 'tem doc de metas'); assertEq(dm._uAt, 555, 'metas carimbada com _uAt');
  assert(!docs.find(d => d.id === '_cfgUAt'), 'relógio local não sincroniza');
  assert(!docs.find(d => d.id === 'leads'), 'coleção não vira doc de config');
});
// Segurança: senhas NUNCA vão para a nuvem (auth real é o Firebase Auth; ST.senhas é só cache offline)
test('fsConfigDocs NUNCA inclui senhas', () => {
  T.ST.senhas = { 'fulano@x.com': 'hash123' };
  const docs = T._fsConfigDocs();
  assert(!docs.find(d => d.id === 'senhas'), 'senhas não pode sincronizar (segredo)');
});

// IDs: só dígitos e únicos (anti-colisão entre máquinas)
test('newId é só dígitos e único', () => {
  const a = T._newId(), b = T._newId();
  assert(/^\d+$/.test(String(a)), 'só dígitos'); assert(a !== b, 'ids diferentes');
});

// Data local: _hojeLocal/_mesLocal usam fuso LOCAL (não UTC) — evita gravar "amanhã" à noite no Brasil
test('hojeLocal formato YYYY-MM-DD e bate com a data local', () => {
  const d = new Date();
  const esperado = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(T._hojeLocal()), 'formato YYYY-MM-DD');
  assertEq(T._hojeLocal(), esperado);
});
test('mesLocal é o prefixo YYYY-MM de hojeLocal', () => {
  assertEq(T._mesLocal(), T._hojeLocal().slice(0, 7));
});

// ── relatório ──
console.log('\n=== Testes Casa Villare — lógica crítica ===');
console.log('Passou: ' + pass + '   Falhou: ' + fail);
if (fail) { console.log('\nFALHAS:'); fails.forEach(f => console.log(' - ' + f)); process.exit(1); }
console.log('✅ TODOS OS TESTES PASSARAM');
