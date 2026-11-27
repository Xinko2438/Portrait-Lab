const {createHash} = require('node:crypto');
const {readFileSync, writeFileSync, copyFileSync} = require('node:fs');
const {join} = require('node:path');

const preview = join(__dirname, 'site', 'folio', 'portrait-lab');
const revision = path => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12);

const app = join(preview, 'app.js');
let script = readFileSync(app, 'utf8');
const oldVisibilityRules = [
  "  elements.reviewReferences.dataset.hasReferences = String(groups.length > 0);",
  "  elements.reviewReferences.hidden = mediaMode === 'comparison' || elements.reviewReferences.dataset.hasReferences !== 'true';",
];
const remainingRules = oldVisibilityRules.filter(rule => script.includes(rule));
if (remainingRules.length && remainingRules.length !== oldVisibilityRules.length) {
  throw new Error('Partial reference strip rules in preview baseline');
}
for (const rule of remainingRules) script = script.replace(new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\r?\\n'), '');
if (!script.includes('elements.reviewReferences.hidden = groups.length === 0;') || script.includes('reviewReferences.dataset.hasReferences')) {
  throw new Error('Unexpected reference strip baseline');
}
writeFileSync(app, script);

copyFileSync(join(__dirname, 'app.css'), join(preview, 'app.css'));
const start = join(preview, 'demo-start.js');
const entry = readFileSync(start, 'utf8');
const newEntry = entry.replace(/(entry \+ '\?v=)[a-f0-9]{12}/, (_, prefix) => prefix + revision(app));
if (!newEntry.includes('?v=' + revision(app))) throw new Error('Missing preview application revision');
writeFileSync(start, newEntry);

const index = join(preview, 'index.html');
const html = readFileSync(index, 'utf8');
const newHtml = html.replace(/((?:app\.css|demo-start\.js)\?v=)[a-f0-9]{12}/g, (_, prefix) =>
  prefix + revision(join(preview, prefix.split('?')[0])));
writeFileSync(index, newHtml);
