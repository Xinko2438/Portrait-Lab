const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, copyFileSync } = require('node:fs');
const { join } = require('node:path');
const preview = join(__dirname, 'site', 'folio', 'portrait-lab');
function revision(name) {
  return createHash('sha256').update(readFileSync(join(preview, name))).digest('hex').slice(0, 12);
}
for (const name of ['app.css', 'app.js']) copyFileSync(join(__dirname, name), join(preview, name));
const startPath = join(preview, 'demo-start.js');
const start = readFileSync(startPath, 'utf8').replace(/(entry \+ '\?v=)[a-f0-9]{12}/, (_, prefix) => prefix + revision('app.js'));
if (!start.includes('?v=' + revision('app.js'))) throw new Error('Unexpected application entry point');
writeFileSync(startPath, start);
const html = readFileSync(join(__dirname, 'index.html'), 'utf8')
  .replace(/((app\.css|demo-start\.js)\?v=)[a-f0-9]{12}/g, (_, prefix, name) => prefix + revision(name));
writeFileSync(join(preview, 'index.html'), html);
