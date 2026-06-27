# Auditoria de Engenharia — ERP Casa Villare
> Data: 27/06/2026 · Escopo: `index.html` (~15,4k linhas), `nfe-worker/worker.mjs`, `firestore.rules`.
> Método: 6 auditorias paralelas (sync/integridade, financeiro, fiscal, segurança, qualidade/perf, CRM/agenda). Cada achado verificado no código real (`arquivo:linha`). Críticos de maior impacto reconferidos manualmente.

---

## Veredito geral

O ERP está **funcional e com boa base** (Simples Nacional, sync em tempo real, tombstones, testes). Mas a auditoria encontrou **5 problemas críticos** — alguns já causando perda silenciosa de informação financeira e um que **impede a emissão fiscal em produção**. A causa-raiz da maioria são **8 padrões transversais**, então corrigir a raiz resolve vários achados de uma vez.

### Causas-raiz transversais
| | Raiz | Achados que ela gera |
|---|---|---|
| A | **ID de 19 dígitos** (string) coagido para `Number` em alguns pontos | baixa em massa quebrada; risco de colisão de id |
| B | **Não existe uma fonte única de "valor líquido da venda"** | 3 bases de comissão divergentes; DRE pelo bruto; valor do pedido congelado |
| C | **Autorização 100% no cliente; `firestore.rules` abertas** | qualquer autenticado lê/apaga tudo; senhas e API key fiscal expostas |
| D | **Sync por documento inteiro**, sem versionamento/mutex/retry | last-write-wins; corridas; falhas silenciosas |
| E | **NFe**: vocabulário de ambiente quebrado, XML só como link, endpoint aberto | produção inalcançável; risco de perder doc legal; emissão por terceiros |
| F | **Datas**: `+30 dias`, fuso UTC, sem validação | boleto pula meses; competência errada; datas absurdas aceitas |
| G | **XSS armazenado** (uso inconsistente de `_esc`) | nome de cliente executa script na sessão de outro |
| H | **Transições lead↔pedido** sem invariantes | pedido órfão; pedido duplicado; agenda dessincronizada |

---

## P0 — Críticos (tratar antes de seguir)

### P0-1 · Baixa de parcelas em LOTE não recebe de verdade (dinheiro some) ✔confirmado
`index.html:13056` `parseInt(el.dataset.cond)` vira Number e `:13059` compara com `===`. Os ids são strings de 19 dígitos → `parseInt` arredonda **e** string≠número → `find` retorna `undefined`, nenhuma parcela é baixada, mas aparece "recebido". (A baixa individual `:13133` usa `==` e funciona por acaso.)
**Impacto:** parcelas marcadas como recebidas em massa continuam eternamente "a receber". **Correção:** não coagir id; comparar `String(x.id)===String(condId)`. **Risco da correção:** baixo, cirúrgico.

### P0-2 · NFe em PRODUÇÃO é inalcançável; UI diz "Produção" mas emite em homologação ✔confirmado
Seletor grava `ProductionEnvironment` (`:1896`,`:7945`), mas `:15105` testa `cfg.ambiente==='producao'` (string que nunca casa) → `amb` é **sempre** `homologacao`. Há ainda duas fontes de verdade para ambiente (config × modal, `:15010` vs `:15105`).
**Impacto:** bloqueia a virada de produção (Tarefa 4); pior, se "consertado" pela metade, risco de emitir em produção achando que é teste. **Correção:** unificar vocabulário para `homologacao`/`producao` em toda a cadeia; confirmação explícita para produção. **Risco:** médio (fiscal) — fazer com cuidado.

### P0-3 · Senhas e API Key fiscal sincronizadas na nuvem, legíveis por qualquer usuário ✔confirmado
`ST.senhas` (`:2700`) e `ST.configNFe.apiKey` não estão nas listas de skip → viram `_config/senhas` e `_config/configNFe` no Firestore, que **qualquer autenticado lê**. Hash SHA-256 com **salt fixo global** (`'cvp2024'`) e senha padrão `'villare'`.
**Impacto:** uma vendedora no console baixa todos os hashes (quebráveis offline) e a chave de emissão fiscal. **Correção:** erradicar `ST.senhas` (usar só Firebase Auth); tirar `apiKey` do client (já vive no Worker); apagar os docs `_config/senhas` e `_config/configNFe` que já vazaram.

### P0-4 · Autorização só no navegador; regras do Firestore abertas
`firestore.rules`: `read: if autenticado()` e `write: if autenticado()` para quase tudo. "Só gestor exclui / lê auditoria" é apenas CSS/JS (`:126`,`:3648`). Trilha `_audit` é **forjável** (`create: if autenticado()`, autor vem do cliente). Tombstones em `_config` deixam **qualquer um apagar dados de qualquer um** (vetor de destruição em massa).
**Impacto:** confidencialidade e integridade do ERP inteiro dependem do navegador. **Correção:** custom claims por perfil + regras por coleção/perfil/propriedade + auditoria gravada por Cloud Function (é a Tarefa 6 — agora urgente).

### P0-5 · XSS armazenado via nome de cliente / descrição / observação
Pontos sem `_esc`: kanban e lista de Pedidos (`:10825`,`:10882`,`:10987`), mural de avisos autor (`:4292`), obs de folha (`:4405`,`:4562`), e outros. `_esc()` existe (`:2722`) mas não é usado nesses pontos.
**Impacto:** um lead com nome `<img src=x onerror=...>` executa script **na sessão do gestor** ao abrir Pedidos — exfiltra `ST` (financeiro, cache) ou age como gestor. **Correção:** envolver todo campo de usuário com `_esc()`, inclusive em atributos (`title="${_esc(nome)}"`).

---

## P1 — Altos (integridade de dados / financeira)

**Sincronização**
- **Edição simultânea do mesmo registro = last-write-wins silencioso** (`_fsSyncCollection`/listener). Duas máquinas editando campos diferentes do mesmo lead → uma perde. Falta merge por campo / `_uAt` no listener.
- **Corrida `_fsLoadAll` × sync/listener**: `_fsSeen` é zerado no meio do load assíncrono; sem mutex entre load e escrita → delete pode se perder / registro ressuscita.
- **Colisão de ID entre máquinas** (`_newId`, salt de 3 dígitos por sessão, 1/1000): `set(doc(id))` sobrescreve silenciosamente. Usar identificador estável de máquina + `randomUUID`.

**Financeiro (raiz B — uma função única de valor líquido resolve 4 itens)**
- **3 bases de comissão diferentes para a mesma venda** (card × resumo × modal): deduzem RT/taxa de formas distintas → comissão diverge entre telas e folha.
- **Taxa de cartão/financiamento na tela de comissão fica 0** (`_vcTaxaAuto` devolve objeto, vira `"[object Object]"`→`0`): comissão calculada sobre base inflada (paga a mais).
- **DRE conta `vendasCom` pelo BRUTO** (com desconto, sem dedução) e sem dedup com leads → receita inflada / dupla contagem.
- **Valor do pedido congela na criação**: alterar o valor do lead depois não atualiza o pedido (comissão usa lead vivo, KPIs usam snapshot) → números divergem.
- **Boleto parcelado soma `+30 dias`** (introduzido nesta sessão): em meses curtos pula um mês inteiro (1ª em 31/01 → 2ª em 02/03). Trocar por incremento de mês.

**Fiscal**
- **XML/DANFE salvos só como LINK do Focus** (`worker.mjs:114`): se a conta/provedor mudar, perde-se o documento legal (guarda de 5 anos). Baixar e arquivar o XML autorizado.
- **Endpoint `/emitir` aberto** (CORS `*`, sem auth, `ref` previsível): qualquer um que ache a URL (pública no client) emite NFe real e lê dados fiscais via `/status`. Exigir segredo + restringir origem.
- **Reenvio gera `ref` nova a cada clique** → risco de emitir 2 notas para a mesma venda. Usar `ref` determinística por pedido.

**CRM / produção**
- **Reverter lead de "ganho" deixa pedido/comissões órfãos** e mantém `dataFechamento` (rollback é um `confirm` ignorável) → DRE/Metas/Comissões divergem permanentemente.
- **Dupla criação de pedido** por caminhos diferentes (lead × cadastro) quando `leadId` diverge → pedidos/comissões em dobro.
- **Avanço rápido de etapa (`pedAvancar`) não grava datas de marco** → comissão de projetista/montador cai no mês errado.
- **Sem validação de datas** (venda/marcos): aceita ano absurdo ou ordem ilógica; pedido nunca aparece como atrasado.

**Performance (piora com volume)**
- **Cada documento que chega da nuvem re-renderiza a aba inteira** (`_reRenderAtual`) + `JSON.stringify(ST)` no localStorage. Com 1000+ registros e vários usuários, trava a UI. Debounce + coalescer.
- **`save()` serializa todo o `ST`** a cada gravação e se aproxima do limite de ~5MB do localStorage. Migrar massa para IndexedDB (já há `cvDB`).

---

## P2 — Médios / Baixos (robustez e manutenção)

- **Tombstone**: prune a 180 dias pode ressuscitar doc cujo delete falhou; `_config/_tomb` é doc único que cresce até o limite de 1MB do Firestore (aí o sync de exclusões para **em silêncio**). Particionar/sharding.
- **`catch(e){}` silenciosos** em caminhos de sync/persistência: falha sem aviso nem retry. Fila de pendências + badge "N não sincronizado".
- **Órfãos referenciais**: excluir lead/pedido não trata comissões avulsas, contasPagar, DRE e cadastros vinculados.
- **Loops O(n×m)** em renders (pedido→equipe, ganho→cadastro): pré-indexar com `Map`.
- **Duplicidade de cliente/CPF**: nada impede cadastrar o mesmo cliente duas vezes.
- **Agenda dessincroniza ao recuar a etapa de Apresentação** (evento `aga_` não é removido).
- **Fuso UTC** em marcos/competência (`new Date().toISOString()` à noite vira o dia seguinte); padronizar `+'T12:00'`/data local.
- **NFe diversos**: `_nfeMapStatus` não cobre todos os estados (status "preso"); destinatário sempre "Isento" (quebra PJ contribuinte); endereço do emitente hardcoded Valinhos/SP; resposta malformada vira `processing` fantasma; "Testar conexão" ainda aponta para NFE.io/Netlify (morto).
- **Segurança extra**: CDNs sem SRI (supply-chain); `localStorage` em claro com CPF/financeiro (LGPD); logout não limpa cache.
- **Financeiro fino**: tolerância de R$ 1,00 no fechamento de condições; semântica ambígua do "valor" do financiamento (parcela × total); arredondamento de pontos na fronteira de faixa.
- **Código morto**: `togglePerdidos()`, `_parseDateBR()`.

---

## Pontos corretos (para contexto)
- Parsing de moeda BR (`_parseBRL`/`parseMoeda`) está correto.
- Rateio de desconto da NFe (último item absorve centavos) correto; PIS/COFINS/CSOSN coerentes com Simples.
- Tokens do Focus protegidos como secrets do Worker.
- Tombstones agora unidos entre máquinas (correção desta semana); uso amplo e correto de `+'T12:00'` e `_esc` na maioria dos pontos.
- `save()`/`load()` principais tratam erro e corrupção de localStorage.

---

## Sequência recomendada (respeitando "um de cada vez, zero regressão")
1. **P0-1** (baixa em massa) — correção cirúrgica, alto impacto, baixo risco. **Começar por aqui.**
2. **P0-5** (XSS) + **P0-3** (tirar senhas/apiKey do sync) — segurança aditiva, baixo risco.
3. **P0-2** (ambiente NFe) — desbloqueia a virada de produção (Tarefa 4).
4. **P0-4** (regras/perfis no servidor) — é a Tarefa 6; maior, faseado com re-login.
5. **P1 financeiro raiz B** (fonte única de valor líquido) — corrige 4 itens juntos.
6. **P1 sync** (last-write-wins, corrida, id) e **performance** (debounce/IndexedDB).
7. **P1 fiscal** (arquivar XML, fechar endpoint) e **CRM** (reversão de ganho, dupla criação, validação de datas).
8. **P2** conforme prioridade.

Cada item: commit antes, testes verdes, deploy isolado, rollback pronto.
