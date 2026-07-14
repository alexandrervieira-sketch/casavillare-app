# 🔒 Checklist C1 — Fechar acesso externo (regras + auto-cadastro)

Auditoria 13/07/2026. Execute na ordem. Cada fase é reversível.
Marque `[x]` conforme concluir. Nada aqui tranca a equipe se a sequência for respeitada.

Referências no repo: `firestore.rules.proposto`, `storage.rules.proposto`.

---

## Fase 0 — Conferir ANTES (não muda nada) ⏱️ ~5 min

- [ ] Console → **Authentication → Users**: todas as contas terminam em `@casavillare.com.br`?
      - [ ] Se alguma usa OUTRO domínio → **PARE** e avise (a regra trancaria essa pessoa).
- [ ] Anotar quantas contas estão com **e-mail NÃO verificado**: ______
      - [ ] Se a maioria não está verificada → **não** usar a opção `email_verified` (Fase 4) por enquanto.

✅ Só seguir se todas as contas forem do domínio corporativo.

---

## Fase 1 — Deploy da regra de domínio (mata o ataque) ⏱️ ~10 min

- [ ] Substituir `firestore.rules` pelo conteúdo de `firestore.rules.proposto`
      (versão `corporativo()` **SEM** `email_verified` — a ativa por padrão).
- [ ] Substituir `storage.rules` pelo conteúdo de `storage.rules.proposto`.
- [ ] Rodar `node _deploy_rules.js`.
- [ ] **Testar logado**: abrir o app e confirmar que leads / pedidos / cadastros
      **carregam e salvam** normalmente.
- [ ] Confirmar (opcional) que o financeiro (folha/comissões) ainda abre só p/ gestor/financeiro.

🔁 Rollback: redeployar as regras antigas (estão no git).
🎯 Resultado: conta externa (`hacker@gmail.com`) não passa mais no domínio → buraco crítico fechado.

---

## Fase 2 — Fechar o auto-cadastro ⏱️ ~5 min

- [ ] Console → **Authentication → Sign-in method → Email/Password**.
- [ ] Desabilitar o auto-registro **OU** manter só para login e criar contas manualmente.
- [ ] Testar: a partir de agora, conta nova é criada por você em **Users → Add user**.

🎯 Resultado: nem criar conta externa é mais possível.

---

## Fase 3 — App Check (defesa extra, modo seguro) ⏱️ dias de observação

- [ ] Console → **App Check** → registrar o app web (reCAPTCHA v3 / Enterprise).
- [ ] Deixar em **modo "Monitorar"** (NÃO "Impor").
- [ ] Acompanhar métricas por alguns dias: tráfego legítimo aparece como **verificado**?
      - [ ] Se aparecer requisição legítima como NÃO-verificada → resolver ANTES de impor.
- [ ] Só então mudar **Firestore** e **Storage** para **"Impor"**.

⚠️ Nunca ligar direto em "Impor" — pode bloquear o app real.

---

## Fase 4 — (Opcional, depois) Exigir e-mail verificado ⏱️ conforme Fase 0

- [ ] Só se a Fase 0 mostrou contas verificadas (ou você verificou todas).
- [ ] Verificar/reenviar verificação para todas as contas ativas.
- [ ] Trocar `corporativo()` para a versão comentada (com `email_verified == true`)
      no `firestore.rules.proposto`.
- [ ] Redeployar as regras (`node _deploy_rules.js`) e testar login de todos.

---

## Prioridade
**Fase 1 + Fase 2** já fecham o crítico. Fase 3 e 4 são camadas extras, sem pressa.

## Relacionado (fora deste checklist)
- **C2** (worker de NFe): ver `nfe-worker/AUTH_C2.mjs` + `nfe-worker/AUTH_C2_CLIENT.md`.
- **Deploy do código** A/M/B já commitado: `node _deploy.js`.
- Trocar o **token do GitHub em texto plano** no `.git/config` por credential helper.
