const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, copyFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const preview = process.argv[2] ? resolve(process.argv[2]) : join(__dirname, 'site', 'folio', 'portrait-lab');
function revision(name) {
  return createHash('sha256').update(readFileSync(join(preview, name))).digest('hex').slice(0, 12);
}
for (const name of ['app.css', 'app.js', 'demo-worker.js', 'history-workspace.js', 'work-library-state.js', 'annotation-editor.js', 'review-workspace-state.js']) copyFileSync(join(__dirname, name), join(preview, name));
const appPath = join(preview, 'app.js');
const app = readFileSync(appPath, 'utf8');
if (!app.includes("import('./annotation-editor.js')")) throw new Error('Unexpected annotation editor entry point');
writeFileSync(appPath, app.replace("import('./annotation-editor.js')", "import('./annotation-editor.js?v=" + revision('annotation-editor.js') + "')"));
const startPath = join(preview, 'demo-start.js');
const start = readFileSync(startPath, 'utf8')
  .replace(/(demo-worker\.js\?v=)[a-f0-9]{12}/, (_, prefix) => prefix + revision('demo-worker.js'))
  .replace(/(entry \+ '\?v=)[a-f0-9]{12}/, (_, prefix) => prefix + revision('app.js'))
  .replace("run.run_id === 'run-demo-selected'", "run.run_id === new URL(link.href).searchParams.get('run')");
if (!start.includes('?v=' + revision('app.js'))) throw new Error('Unexpected application entry point');
writeFileSync(startPath, start);
const html = readFileSync(join(__dirname, 'index.html'), 'utf8')
  .replace(/((app\.css|demo-start\.js)\?v=)[a-f0-9]{12}/g, (_, prefix, name) => prefix + revision(name));
writeFileSync(join(preview, 'index.html'), html);
