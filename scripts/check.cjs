const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let failed = false;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(cjs|mjs|js)$/.test(file)) {
      const result = spawnSync(process.execPath, ['--check', file], {encoding:'utf8'});
      if (result.status !== 0) { console.error(result.stderr); failed = true; }
    }
  }
}
walk(path.join(root, 'src'));
walk(path.join(root, 'scripts'));
walk(path.join(root, 'internet-service', 'src'));
console.log(failed ? 'Syntax checks failed.' : 'All JavaScript syntax checks passed.');
process.exitCode = failed ? 1 : 0;
