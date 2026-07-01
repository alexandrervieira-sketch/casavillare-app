# Auditoria Geral — ERP Casa Villare (30/06/2026)

> Auditoria com foco em **entendimento financeiro** + saúde geral (dados, sync, regressões).
> Método: 4 auditores em paralelo (financeiro/comissões, integridade de dados, regressões de hoje, relatórios/display) + verificação manual dos achados críticos no código. `arquivo:linha` conferidos.
> Legenda: **P0** crítico · **P1** impacta entendimento/dados · **P2** menor/latente/edge.

---

## 🎯 TL;DR — o tema central

O maior risco ao seu **entendimento financeiro NÃO é um número corrompido** — é que o sistema tem **várias definições diferentes de "venda líquida", "lucro" e "receita"** convivendo em telas diferentes. Resultado: **o mesmo negócio aparece com números diferentes** dependendo de onde você olha (Metas × DRE × Rentabilidade × ficha nova × Custos Fábrica). Nada está "quebrado", mas as telas **não reconciliam entre si**, e isso engana a leitura.

As mudanças de **hoje** (NFe, fuso, custos, ficha de rentabilidade) foram auditadas e estão **limpas — sem regressão**.

---

## 🟠 P1 — Impactam o entendimento financeiro / dados

### 1. Múltiplas definições de "venda líquida / lucro / receita" (o problema-mãe)
Cada tela calcula de um jeito:

| Tela | Base de "venda" | Comissões incluídas | Observação |
|---|---|---|---|
| **Ficha de Rentabilidade** (nova) | líquido = desconto→taxa→RT (`_vendaLiquido`) | as 4 (vend, proj, mont, superv) | modelo completo/correto |
| **Relatório Rentabilidade** (`calcRent`, ~6262) | só pós-**desconto** (sem taxa); RT em base errada | só vendedor (e lê da folha → **0** se não houver folha) | card "Lucro Bruto" diverge da ficha |
| **Metas / Vendas do mês** (`_vendasMes`, ~13957) | **BRUTO** (soma ambientes **sem** desconto) | — | superestima a venda |
| **DRE** (`calcDRE`, ~12718) | líquido pós-**desconto** (sem taxa/RT) | — via folha | 3ª definição de receita |
| **Custos Fábrica** (%, ~5465/5479) | denominador **BRUTO** (`p.valor`) | — | % de custo parece menor do que é |

**Efeito prático:** venda de 200k, 20% desc, 16% taxa, 10% RT →
- Metas conta **200.000** · DRE conta **160.000** · Rentab. (card antigo) trata **160.000** · Ficha nova trata **120.960**.
- Custos Fábrica: custo 60k / 200k = **30% (verde)**, quando sobre o líquido é **~37–50% (amarelo/vermelho)**.
- Na aba Rentabilidade, a **linha da tabela** (lucro antigo) mostra um número e, ao **clicar** nela, a **ficha** mostra outro — para o mesmo projeto.

**Onde:** `index.html:6266` (`calcRent.valorLiq`), `:6281` (RT), `:5465/5479/5515` (% Custos Fábrica), `:13957` (`_vendasMes`), `:12718` (DRE).

**Correção proposta:** eleger **uma fonte única de "venda líquida"** (`_vendaLiquido`, que já é a oficial das comissões) e fazer Rentabilidade, Custos Fábrica %, Metas e DRE **todos derivarem dela** — ou, onde a base bruta for intencional (ex.: meta sobre valor cheio), **rotular explicitamente** ("bruto" × "líquido"). **Precisa de decisão sua** (ver seção "Decisões").

### 2. RT calculada em bases diferentes
`pdCalcMargem` (`:11376`) e o preview de comissão do lead (`:10005`) calculam **RT sobre o valor pós-desconto**, enquanto a fonte oficial `_vendaLiquido` (`:6836`) calcula **RT sobre o pós-desconto-e-taxa**. Quando a loja absorve taxa de cartão, o RT (e o lucro/comissão do preview) aparece maior do que o motor real paga. Subitem do #1.

### 3. Agenda: coleção `eventos` fora da lista de seed  *(verificado)*
`index.html:3402` — a lista que inicializa as coleções **não inclui `eventos`** (a agenda real). Em **máquina nova / cache limpo**, se o `_fsLoadAll`/`_fsSubscribe` roda antes de abrir a Agenda, os eventos da nuvem **não carregam nessa sessão** (o listener é one-shot). **Auto-cura no F5** e **não há perda de dado** (coleção vazia não sobrescreve nuvem). Correção: **1 linha** (adicionar `'eventos'` ao seed).

### 4. Excluir cadastro deixa `clienteCadId` órfão → NFe com dados fiscais errados
`:12639`/`:12649` — excluir um cadastro de cliente **não avisa** nem trata pedidos que apontam para ele. A emissão de NFe lê CNPJ/IE/endereço/nº contrato do cadastro (`:15250`+); se ele sumiu, a **nota pode sair com dados em branco/errados**. Correção: ao excluir, avisar se há pedidos vinculados e/ou limpar o `clienteCadId`.

### 5. Re-salvar cadastro sobrescreve valor/contrato editado à mão no pedido
`:12604`–`12620` — salvar o cadastro de um cliente (mesmo só mudando um telefone) **recalcula e sobrescreve** `valor`, `nContrato`, `responsavel` e `descricao` do pedido vinculado, **sem aviso e sem checagem de conflito**. Se alguém ajustou o valor do pedido na mão, perde. Correção: só sobrescrever campos que o cadastro é dono, ou pular campos editados; carimbar `_uAt`.

### 6. Sem guarda de duplicidade (cadastro e pedido)
Não há trava impedindo **2 cadastros para o mesmo cliente/lead** nem **2 pedidos para o mesmo lead** (o guard só olha a memória local; entre máquinas, os dois sobrevivem). Gera produção/comissão duplicadas. Correção: procurar existente por `leadId`/CPF antes de criar; id determinístico para o pedido auto-criado.

---

## 🟡 P2 — Menores / latentes / edge

7. **Comissão do vendedor na cascata sem margem de erro** (`_cascataProjeto`) — inconsistente com a folha e com os outros 3 papéis. **Dormente** (margem de erro = 0 hoje). Corrigir por consistência.
8. **DRE não desconta taxa/RT** da receita (defensável como visão bruta, mas o rótulo "Receita de Vendas (CRM)" confunde). Rotular.
9. **DRE ignora custo de fábrica/fornecedor dos pedidos** no CPV (só entra CPV manual) — um mês com muita fábrica e sem lançamento manual mostra **lucro bruto inflado**. Puxar automático ou avisar.
10. **Alerta "Contas a Receber a vencer" não filtra status do lead** (`:3870`) — lead reaberto/perdido ainda aparece com parcelas a receber.
11. **Tombstone usa relógio local** na união — skew de relógio entre máquinas pode, no limite, perder um delete/recriação de evento (id determinístico). Edge.
12. **Cosmético:** botão 📊 usa `p.id` cru vs `_sid(p.id)` no resto — inócuo (ids são só dígitos).

---

## ✅ Verificado e SAUDÁVEL

- **Mudanças de hoje** (NFe IE, fuso `_hojeLocal`/`_mesLocal`, relatório de custos, ficha de rentabilidade, fábrica, e-mails múltiplos, voltar etapa): **sem regressão**. Os ~40 pontos de fuso trocados estão todos em contexto de "data do dia"; os `toISOString` restantes são timestamps completos ou datas em meia-noite local (corretas no fuso BR).
- **Anti-clobber de config** (`_cfgSyncPronto`, `_cfgVazio`, `_cfgUAt`): sólido.
- **Coleções não são apagadas** por ausência local sem tombstone; permissão/rede indisponível = "não mexe".
- **Tombstones são UNIDOS** (não sobrescritos); onSnapshot re-deleta ressurreições.
- **IDs de 19 dígitos**: comparações usam `String(a)===String(b)` em todo lugar — seguro.
- **Exclusão de lead/pedido** faz cascata correta (agenda, comissões, adiantamentos).
- **Competência das comissões** usa data local (sem "pulo" de mês por fuso).

---

## 🧭 Decisões que preciso de você (antes de corrigir o #1)

O #1 é o mais valioso, mas depende da **sua intenção de negócio**:
1. **Meta de vendas** deve ser sobre o valor **bruto (cheio)** ou **líquido (o que o cliente contrata, pós-desconto)**?
2. **"Venda líquida" para lucro/custo** deve descontar **taxa de cartão e RT** (como a ficha nova) em todas as telas?
3. O card antigo "Lucro Bruto" da aba Rentabilidade: **aposento** ele (deixo só a cascata completa) ou **mantenho rotulado** como modelo simplificado?

Com essas 3 respostas, eu unifico tudo numa fonte só e as telas passam a reconciliar.

---

## 🔢 Ordem de correção sugerida (uma de cada vez, testando)

1. **#3 (eventos no seed)** — trivial, 1 linha, risco zero. *Já faço se você autorizar.*
2. **#4 e #5** (cadastro órfão / clobber do pedido) — proteção de dados, baixo risco.
3. **#1 + #2** (unificar "venda líquida") — **depende das suas 3 respostas**; maior valor.
4. **#6** (duplicidade) — médio.
5. **#8, #9, #10** (DRE/receber) — ajustes de leitura financeira.
6. **#7, #11, #12** — polimento/latentes.
