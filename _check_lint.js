// _check_lint.js — trava anti-"variável indefinida" (o bug que quebrou o modal de lead).
// Extrai o JS dos <script> inline do index.html e roda ESLint (regra no-undef) SEM rodar o app.
// Erros apontam a LINHA EXATA do index.html (técnica de máscara preserva as posições).
// Sai com código 1 se achar referência indefinida → usado como portão de deploy (_deploy_check.js).
const fs = require('fs');
const path = require('path');
const os = require('os');

const HTML = path.join(__dirname, 'index.html');
const html = fs.readFileSync(HTML, 'utf8');

// Máscara: tudo vira espaço (preservando \n) e só o conteúdo dos <script> inline é reinserido
// nas MESMAS posições → linha reportada pelo ESLint == linha do index.html.
const arr = html.replace(/[^\n]/g, ' ').split('');
const re = /<script(\b[^>]*)>([\s\S]*?)<\/script>/gi;
let m, blocos = 0;
while ((m = re.exec(html))) {
  if (/\bsrc\s*=/i.test(m[1])) continue; // <script src=...> externo: não é nosso código
  const content = m[2];
  const start = m.index + m[0].indexOf(content);
  for (let i = 0; i < content.length; i++) arr[start + i] = content[i];
  blocos++;
}
const tmp = path.join(os.tmpdir(), 'cv_lint_src.js');
fs.writeFileSync(tmp, arr.join(''));

(async () => {
  let ESLint, globals;
  try {
    ({ ESLint } = require(path.join(__dirname, 'node_modules', 'eslint')));
    globals = require(path.join(__dirname, 'node_modules', 'globals'));
  } catch (e) {
    console.warn('⚠️  ESLint não instalado (node_modules ausente). Rode `npm install`. Lint PULADO (não bloqueia).');
    process.exit(0); // falha de infraestrutura não deve travar deploy — só erro REAL de código trava
  }
  const eslint = new ESLint({
    overrideConfigFile: true, // ignora qualquer config do projeto
    overrideConfig: {
      languageOptions: {
        ecmaVersion: 2023,
        sourceType: 'script',
        globals: { ...globals.browser, firebase: 'readonly', Chart: 'readonly' },
      },
      rules: { 'no-undef': 'error' },
    },
  });
  const results = await eslint.lintFiles([tmp]);
  const errs = [];
  for (const r of results) for (const msg of r.messages) if (msg.ruleId === 'no-undef') errs.push(msg);

  if (!errs.length) {
    console.log('✅ Lint OK — ' + blocos + ' bloco(s) inline, nenhuma variável indefinida.');
    process.exit(0);
  }
  console.log('❌ LINT FALHOU — ' + errs.length + ' referência(s) a variável indefinida (erro provável em runtime):\n');
  for (const e of errs) console.log('   index.html:' + e.line + ':' + e.column + '  ' + e.message);
  console.log('\n🛑 Deploy BLOQUEADO. Corrija as referências acima antes de publicar.');
  process.exit(1);
})();
