# C2 — Patch do CLIENTE (index.html) para autenticar as chamadas ao Worker de NFe

> ⚠️ **NÃO aplicar isoladamente.** Este patch faz o navegador enviar o header
> `Authorization: Bearer <idToken>`. O Worker atual só libera `Content-Type` no
> CORS (`Access-Control-Allow-Headers`), então enquanto o worker não for atualizado
> (AUTH_C2.mjs) o **preflight bloqueia** a chamada e a emissão de NFe QUEBRA.
>
> **Ordem de virada (cutover) obrigatória:**
> 1. Atualizar o `worker.mjs` com `AUTH_C2.mjs` (inclui `Authorization` no
>    `Access-Control-Allow-Headers` e o `assertAuth`).
> 2. `wrangler secret put FB_PROJECT` + `node _deploy_worker.js`.
> 3. **Só então** aplicar este patch no `index.html` + `node _deploy.js`.
>
> Ao restringir o CORS a um único origin no worker, teste antes em homologação:
> um mismatch de origin também bloqueia via CORS.

---

## 1) Adicionar o helper (uma vez)

Colar perto da constante `NFE_PROXY_URL` (~linha 16136):

```js
// C2 — chamada autenticada ao Worker de NFe: injeta o Firebase ID token do usuário logado.
// O worker verifica a assinatura + perfil (gestor/financeiro). Health check GET '/' fica público.
async function _nfeFetch(path, opts={}){
  const u = (typeof firebase!=='undefined' && firebase.auth) ? firebase.auth().currentUser : null;
  const token = u ? await u.getIdToken() : '';
  const headers = { ...(opts.headers||{}) };
  if(token) headers['Authorization'] = 'Bearer ' + token;
  return fetch(NFE_PROXY_URL + path, { ...opts, headers });
}
```

## 2) Trocar os 8 fetch autenticados: `fetch(NFE_PROXY_URL + X, opts)` → `_nfeFetch(X, opts)`

O health check (`GET '/'`, ~16369) **fica como está** (público).

| Linha | Antes | Depois |
|-------|-------|--------|
| ~16164 | `await fetch(NFE_PROXY_URL+'/arquivo?tipo=xml&ref='+encodeURIComponent(ref)+'&ambiente='+amb);` | `await _nfeFetch('/arquivo?tipo=xml&ref='+encodeURIComponent(ref)+'&ambiente='+amb);` |
| ~16173 | `await fetch(NFE_PROXY_URL+'/arquivo?tipo=danfe&ref='+encodeURIComponent(ref)+'&ambiente='+amb);` | `await _nfeFetch('/arquivo?tipo=danfe&ref='+encodeURIComponent(ref)+'&ambiente='+amb);` |
| ~16217 | `await fetch(NFE_PROXY_URL+'/email',{method:'POST',headers:{'Content-Type':'application/json'},body:...});` | `await _nfeFetch('/email',{method:'POST',headers:{'Content-Type':'application/json'},body:...});` |
| ~16240 | `await fetch(NFE_PROXY_URL+'/carta-correcao',{...});` | `await _nfeFetch('/carta-correcao',{...});` |
| ~16266 | `await fetch(NFE_PROXY_URL+'/cancelar',{...});` | `await _nfeFetch('/cancelar',{...});` |
| ~16285 | `await fetch(NFE_PROXY_URL+'/status?ref='+encodeURIComponent(p.nfe.ref)+'&ambiente='+amb);` | `await _nfeFetch('/status?ref='+encodeURIComponent(p.nfe.ref)+'&ambiente='+amb);` |
| ~16332 | `await fetch(NFE_PROXY_URL+'/status?ref='+encodeURIComponent(p.nfe.ref)+'&ambiente='+amb);` | `await _nfeFetch('/status?ref='+encodeURIComponent(p.nfe.ref)+'&ambiente='+amb);` |
| ~16620 | `await fetch(NFE_PROXY_URL+'/emitir',{method:'POST',headers:{'Content-Type':'application/json'},body:...});` | `await _nfeFetch('/emitir',{method:'POST',headers:{'Content-Type':'application/json'},body:...});` |

Em cada um, só muda `fetch(NFE_PROXY_URL+` → `_nfeFetch(` (o `opts` continua igual).
O helper mescla o `Content-Type` existente com o `Authorization`.

## 3) worker.mjs — o CORS precisa aceitar o header

No `AUTH_C2.mjs`/`worker.mjs`, o objeto CORS deve incluir `Authorization`:

```js
const CORS = {
  'Access-Control-Allow-Origin': CORS_ORIGIN,           // origin do app (não '*')
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
```

## 4) Validação pós-deploy (homologação primeiro)
- Logado como gestor/financeiro: emitir/consultar/cancelar em HOMOLOGAÇÃO deve funcionar.
- Sem token (ex.: chamar o worker por fora, via curl sem Bearer): deve responder **401**.
- Perfil não-fiscal (ex.: montagem) logado: as ações fiscais devem responder **403**.
- Só depois virar para produção.
