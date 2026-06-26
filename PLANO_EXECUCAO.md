# Plano de Execução — Finalização do ERP Casa Villare

> Documento vivo. Objetivo: levar o sistema de **~75%** a um **ERP profissional completo**, sem gerar **nenhum impacto/regressão** na operação em produção. Atualizado em 25/06/2026.

---

## Princípios inegociáveis (zero impacto)

1. **Uma mudança de cada vez.** Nada de mexer em duas frentes no mesmo deploy.
2. **Validação antes de publicar:** checagem de sintaxe + **suíte de testes** (`node tests/run-tests.js`) verde antes de cada deploy.
3. **Rollback garantido:** todo deploy é precedido de commit no GitHub. Qualquer problema → voltar à versão anterior em segundos.
4. **Aditivo > destrutivo:** preferir adicionar comportamento novo a alterar o existente.
5. **Fiscal só em homologação** até estar 100% validado. Produção é o último passo.
6. **Teste em uma máquina antes de liberar para a equipe** quando a mudança tocar sync/login.

---

## Ordem de execução (prioridade × risco × dependências)

| # | Frente | Responsável | Bloqueado por | Risco | Impacto produção |
|---|--------|-------------|---------------|-------|------------------|
| 1 | NFe — auditar função | 🤖 | — | baixo | nenhum (✅ feito) |
| 2 | NFe — pré-requisitos fiscais | 👤 | — | — | nenhum |
| 5 | Config — carimbo de tempo | 🤖 | — | baixo | nenhum (aditivo) |
| 3 | NFe — deploy + homologação | 🤖 | 1, 2 | médio | nenhum (homologação) |
| 4 | NFe — virada produção | 🤖+👤 | 3 | alto* | controlado |
| 6 | Permissões no servidor | 🤖 | — | médio | baixo (rollout cuidadoso) |
| 7 | Testes automatizados | 🤖 | — | nenhum | nenhum (fora da produção) |
| 8 | Modularização gradual | 🤖 | 7 | alto | controlado (incremental) |

> *Risco "alto" da virada de produção = é emissão fiscal real; mitigado por homologação validada antes.

**Sequência recomendada:** enquanto você reúne os pré-requisitos da NFe (item 2), eu adianto o item 5 (rápido e seguro). Depois NFe (3→4). Em seguida permissões (6) e maturidade de engenharia (7→8).

---

## FRENTE 1 — Fiscal (NFe)  ·  Prioridade máxima

**Objetivo:** emitir NFe de produto direto do pedido, de forma segura e legal.

### Fase 1.1 — Auditoria da função ✅ (feito)
- 🤖 Revisão do payload (emitente, destinatário, itens NCM/CFOP/CSOSN/ICMS, totais).
- Achados: base sólida (Simples Nacional, CFOP interestadual automático). A corrigir no deploy: remover fallback que expõe a API Key no navegador; subir para Node 20.

### Fase 1.2 — Pré-requisitos (👤 você + contador)
- [ ] Conta **NFE.io**: API Key + ID da empresa (Company ID).
- [ ] **Certificado A1** (.pfx + senha) — subir no painel da NFE.io.
- [ ] Dados fiscais confirmados: regime tributário, IE, natureza da operação, **CFOP padrão**, **CSOSN**, série.
- [ ] **NCM** correto dos móveis planejados.
- [ ] Habilitar **homologação** na NFE.io.

### Fase 1.3 — Deploy + Homologação (🤖)  · *zero impacto na produção*
- [ ] Bump da Cloud Function para **Node 20**.
- [ ] Deploy do proxy `nfeEmit` (via REST/gcloud — firebase-tools está quebrado).
- [ ] Mover a API Key para o **servidor**; remover a chamada direta do navegador.
- [ ] Rotear emissão/teste/status pelo proxy (resolve CORS e segredo).
- [ ] Emitir **nota de teste** em homologação e validar ponta a ponta (XML/DANFE/status no pedido).
- **DoD:** nota de homologação emitida e lida corretamente no pedido.

### Fase 1.4 — Virada para Produção (🤖 + 👤)
- [ ] Trocar credenciais/ambiente para produção na NFE.io.
- [ ] Emitir **1ª nota real** controlada e conferir XML/DANFE arquivados.
- **DoD:** primeira NFe real autorizada pela SEFAZ.

---

## FRENTE 2 — Endurecimento de Permissões / Integridade

**Objetivo:** governança de verdade e fim do último risco de perda de dado.

### Fase 2.1 — Carimbo de tempo na config (🤖)  · *rápido, aditivo*  ✅ CONCLUÍDO (26/06)
- **Problema:** meta/fábrica/equipe sincronizam em "última gravação vence"; duas máquinas editando juntas, uma sobrescreve a outra.
- **Solução:** `_uAt` por documento de config; só sobrescreve a nuvem se o local for mais novo.
- **Risco:** baixo (aditivo). **Impacto:** nenhum.
- **DoD:** editar a meta em duas máquinas em sequência não apaga a alteração da outra.

### Fase 2.2 — Permissões no servidor (🤖)
- **Custom claims:** carimbar o perfil (gestor) no token via Admin SDK / Service Account.
- **Regras Firestore por perfil:** exclusão **só-gestor no servidor**; leitura de `_audit` **só-gestor** (à prova de burla via API).
- **Refresh de token** no cliente (re-login) + manutenção do selo ao cadastrar novo gestor.
- **Risco:** médio (mexe no login). **Mitigação:** testar em uma máquina; rollout gradual; rollback pronto.
- **DoD:** colaborador não-gestor não consegue excluir nem ler auditoria nem via API.

---

## FRENTE 3 — Maturidade de Engenharia

**Objetivo:** sustentar o crescimento sem regressões e facilitar manutenção.

### Fase 3.1 — Testes automatizados (🤖)  · *zero impacto*  ✅ CONCLUÍDO (26/06)
> `tests/run-tests.js` — 12 testes da lógica crítica. Rodar `node tests/run-tests.js` **antes de cada deploy**. Ampliar conforme novas mudanças.
- Cobrir os pontos de maior risco: **sincronização** (tombstones, anti-clobber, merge), **comissão** (faixas/marcos/base líquida), **valor de venda** (desconto), **financeiro** (receber/pagar).
- Rodar antes de cada deploy → trava regressão.
- **Risco:** nenhum (aditivo, fora da produção). **DoD:** suíte rodando e barrando uma regressão proposital.

### Fase 3.2 — Modularização gradual (🤖)  · *por último*
- Separar o `index.html` (~14k linhas) em módulos lógicos (sync, CRM, pedidos, financeiro, fiscal, util), **sem mudar comportamento**.
- **Só começa com a Frente 3.1 cobrindo** os pontos críticos.
- **Risco:** alto se feito de uma vez → fazer **incremental**, um módulo por vez, cada passo validado e com rollback.
- **DoD:** código modular, comportamento idêntico, testes verdes.

---

## Garantias de "zero impacto" (resumo)

- ☁️ Deploy sempre após commit (GitHub) → rollback imediato.
- 🧪 Sintaxe validada a cada build; testes (Frente 3) barram regressão.
- 🧾 Fiscal isolado em homologação até validar.
- 🔁 Mudanças de sync/login testadas em uma máquina antes da equipe.
- 🧱 Refatoração só incremental e com testes cobrindo.

---

## Rastreamento

As fases acima estão registradas como tarefas (1 a 8) no painel de tarefas da sessão e na memória do projeto. Este documento é versionado no GitHub e **não vai para o ar** (não está na lista de deploy).
