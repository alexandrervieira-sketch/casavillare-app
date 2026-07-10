// _deploy_check.js — deploy COM trava. Roda o lint (variável indefinida) e só publica se passar.
// Uso: GOOGLE_APPLICATION_CREDENTIALS=<chave.json> node _deploy_check.js
// (substitui o `node _deploy.js` direto — este é o caminho seguro)
const { execFileSync } = require('child_process');
const path = require('path');

console.log('🔎 Verificando o código antes de publicar...');
try {
  execFileSync(process.execPath, [path.join(__dirname, '_check_lint.js')], { stdio: 'inherit' });
} catch (e) {
  console.error('\n🛑 Publicação abortada: o verificador encontrou erro no código.');
  process.exit(1);
}
console.log('🚀 Verificação OK — publicando...\n');
require('./_deploy.js'); // roda o deploy real só se o lint passou
