# Backlog & Plano de Trabalho — ERP Casa Villare

> Documento vivo. Consolida tudo que levantamos (auditoria 27/06, segurança, NFe) — o que já foi feito e o que falta. Atualizado em 28/06/2026.
> Legenda esforço: **P** pequeno · **M** médio · **G** grande. Risco: 🟢 baixo · 🟡 médio · 🔴 alto.

---

## ✅ JÁ CONCLUÍDO (jun/2026)

**Fiscal / NFe**
- **PRODUÇÃO NO AR (30/06/2026)** — 1ª nota real autorizada (Komet, série 1 Nº 2). Numeração do 1 confirmada correta pelo contador. IE de CNPJ obrigatória (SP não aceita "Isento"). XML/DANFE arquivados no Storage.
- Emissão validada em homologação (Focus NFe via Cloudflare Worker, arquitetura provider-agnóstica).
- (a) Arquivamento de XML/DANFE no Firebase Storage (guarda de 5 anos).
- (b) Envio do DANFE/XML por e-mail (cliente + contador, editável).
- (c) Cancelamento de nota (com justificativa).
- (d) Carta de Correção (CC-e).

**Auditoria — P0/P1 críticos**
- Baixa de parcelas em lote que não recebia (id de 19 dígitos).
- Ambiente da NFe (produção era inalcançável).
- Segredos (senhas/apiKey) saíam no sync `_config` → bloqueados + limpos.
- XSS armazenado (nome de cliente etc.) → escapados.
- Limpeza total da NFE.io (provedor abandonado).
- **Fonte única do valor líquido** (comissão de todos: cascata desconto→taxa→RT).

**Integridade de dados (correções de perda)**
- Ressurreição de registros excluídos (tombstones agora UNIDOS entre máquinas).
- Perda de metas/config ao salvar antes da nuvem carregar (trava `_cfgSyncPronto`).
- Config vazio da nuvem apagando dados locais (salários).

**Segurança**
- Login 100% Firebase Auth; senha "villare" **erradicada** (todas as 7 contas resetadas).
- Conta nova só por "Primeiro acesso"; bloqueio de senha fraca; "Trocar minha senha"; reset por e-mail.
- Permissões por perfil **no servidor** (Fase 1): financeiro/auditoria só-gestor nas regras do Firestore.
- Perfis carimbados (custom claims) nos 7 usuários.
- Guarda de navegação do dashboard (não-CRM não cai no lead/CRM).

**Engenharia**
- Suíte de testes (23) rodando antes de cada deploy.

---

## 🎯 PENDENTE — organizado por frente

### 🔎 A REVER (demandas do gestor a apurar)
| # | Item | Status |
|---|------|--------|
| ~~R1~~ | ~~Revisar comissão e pontuação~~ ✅ **FEITO (02/07/2026, commit a60ec5f)** — a **taxa absorvida pela loja** (financiamento/cartão) agora entra como **desconto no cálculo da pontuação** do vendedor (`_descEfetivoComissao`, alinhado ao Focco). Confirmado pelo gestor. *Se surgirem mais pontos de comissão/pontuação, reabrir.* | ✅ |

### A) Operacional / Negócio (destrava o resto — não é código)
| # | Item | Esforço | |
|---|------|---------|---|
| A1 | Equipe trocar as **senhas temporárias** pela própria | — | 🟢 |
| ~~A2~~ | ~~1ª venda real → virada de produção da NFe~~ ✅ **FEITA 30/06/2026** (Komet, Nº 2) | — | ✅ |
| A3 | Confirmar **entrega de e-mail em produção** (testar enviando p/ o próprio e-mail numa nota real) | — | 🟢 |

### B) Integridade de dados / Sincronização (alto valor)
| # | Item | Esforço | Risco |
|---|------|---------|-------|
| B1 | Edição simultânea do **mesmo registro** = última gravação vence em silêncio → merge por campo / checar `_uAt` no listener | M | 🟡 |
| B2 | Corrida `_fsLoadAll` × sync → trava (mutex) entre carga e escrita | M | 🟡 |
| B3 | **Colisão de ID** entre máquinas (salt curto) → id estável + `randomUUID` | P | 🟡 |
| B4 | **Fila de pendências** + selo "N alterações não sincronizadas" (hoje falhas de sync são silenciosas) | M | 🟢 |
| B5 | `_config/_tomb` cresce até o limite de 1MB do Firestore → particionar | M | 🟡 |
| B6 | Prune de tombstone (180d) só após confirmar que o doc sumiu da nuvem | P | 🟢 |
| B7 | **Órfãos** ao excluir lead/pedido (comissões avulsas, contasPagar, DRE, cadastros) | M | 🟡 |

### C) Lógica de negócio (CRM / Pedidos / Agenda)
| # | Item | Esforço | Risco |
|---|------|---------|-------|
| C1 | Reverter lead "ganho" deixa **pedido órfão** + mantém `dataFechamento` → divergência DRE/Metas/Comissões | M | 🟡 |
| C2 | **Dupla criação de pedido** por caminhos diferentes (lead × cadastro) | M | 🟡 |
| C3 | Avanço rápido de etapa **não grava datas de marco** → comissão de obras no mês errado | P | 🟢 |
| C4 | **Validação de datas** (venda/marcos: ano absurdo, ordem ilógica) ausente | P | 🟢 |
| C5 | **Valor do pedido congela** na criação (renegociação do lead não propaga) | P | 🟡 |
| C6 | Agenda **dessincroniza ao recuar** a etapa de Apresentação (evento fica) | P | 🟢 |
| C7 | **Duplicidade de cliente/CPF** (nada impede cadastrar 2x) | P | 🟢 |
| C8 | **Fuso horário** em marcos/competência (`toISOString` à noite vira o dia seguinte) | P | 🟡 |

### D) Performance / Escala (importa conforme cresce)
| # | Item | Esforço | Risco |
|---|------|---------|-------|
| D1 | Cada doc da nuvem **re-renderiza a aba inteira** → debounce + coalescer | M | 🟡 |
| D2 | `save()` serializa **todo o estado** no localStorage → IndexedDB / por coleção | G | 🟡 |
| D3 | Loops **O(n²)** em renders (pedido→equipe, ganho→cadastro) → pré-indexar com `Map` | P | 🟢 |

### E) Segurança — Fase 2 (fechar o servidor 100%)
| # | Item | Esforço | Risco |
|---|------|---------|-------|
| E1 | Mover **salários/tabelas** (`_config/configs`, `configsCom`) para coleção **só-gestor** (hoje qualquer logado lê) | M | 🟡 |
| E2 | **Exclusão só-gestor no servidor** (exige repensar o mecanismo de tombstones) | G | 🔴 |
| E3 | **`_audit` à prova de forja** no servidor (Cloud Function / trigger) | M | 🟡 |
| E4 | CDNs com **SRI** + Content-Security-Policy | P | 🟢 |
| E5 | Limpar dados sensíveis do cache no **logout** (LGPD) | P | 🟢 |

### F) Maturidade de engenharia
| # | Item | Esforço | Risco |
|---|------|---------|-------|
| F1 | **Modularização** gradual do `index.html` (~15k linhas) em módulos | G | 🔴 |
| F2 | Ampliar **cobertura de testes** conforme corrigimos B/C | M | 🟢 |
| F3 | Remover **código morto** (`togglePerdidos`, `_parseDateBR`) | P | 🟢 |

### G) Financeiro fino (polimento)
| # | Item | Esforço | Risco |
|---|------|---------|-------|
| G1 | Tolerância de **R$ 1,00** no fechamento de condições → reduzir p/ centavos | P | 🟢 |
| G2 | Semântica do **valor de financiamento** (parcela × total) explícita | P | 🟡 |
| G3 | Arredondamento de **pontos na fronteira** de faixa de comissão | P | 🟢 |

---

## 🗺️ Ordem de trabalho sugerida (uma frente por vez, com testes + rollback)

1. **A** — operacional (senhas + 1ª venda/produção). *Destrava o uso fiscal real.*
2. **C3, C4, C6, C8** — correções de CRM/agenda rápidas e de baixo risco (datas de marco, validação, agenda, fuso). *Muito valor, pouco risco.*
3. **C1, C2, C5, B7** — integridade de pedido/lead e órfãos (médio).
4. **B1–B4** — robustez do sync (edição concorrente, id, fila de pendências).
5. **D1, D3** — performance que pesa com volume (deixar D2/IndexedDB para quando incomodar).
6. **E1, E3, E4, E5** — fechar a segurança no servidor (E2 por último, é o mais delicado).
7. **F3, G1–G3** — polimentos.
8. **F1** — modularização, **por último** (com a suíte de testes cobrindo o que mexemos).

> Princípios mantidos: uma mudança por vez · testes verdes + commit antes de cada deploy · rollback em segundos · mudanças de sync/login testadas numa máquina antes da equipe.
