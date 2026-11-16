import { TEMPLATE_STYLE_VOCABULARY, loadTemplateStyleProgress, loadTemplateStyleProjection, recordTemplateStyleTag } from './template-style-store.mjs';

function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
function status(error) { const message = String(error?.message || error); if (/not found/i.test(message)) return 404; if (/hash mismatch|supersedes/i.test(message)) return 409; return 400; }

export function createTemplateStyleApiHandler({ root }) {
  return async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.match(/^\/api\/templates\/(tpl_temp_aiimg_[a-z0-9_-]+)\/style-tag$/);
    const vocabulary = url.pathname === '/api/template-styles/vocabulary';
    const progress = url.pathname === '/api/template-styles/progress';
    if (!route && !vocabulary && !progress) return false;
    try {
      if (req.method === 'GET' && vocabulary) { json(res, 200, { vocabulary: TEMPLATE_STYLE_VOCABULARY }); return true; }
      if (req.method === 'GET' && progress) { json(res, 200, { progress: await loadTemplateStyleProgress({ root }) }); return true; }
      if (route && req.method === 'GET') { json(res, 200, { projection: await loadTemplateStyleProjection({ root, templateUid: route[1] }) }); return true; }
      if (route && req.method === 'POST') {
        const value = await body(req);
        const result = await recordTemplateStyleTag({ root, templateUid: route[1], imageSha256: value.image_sha256, kind: value.kind, idempotencyKey: value.idempotency_key, actor: value.actor, tag: value.tag, modelVersion: value.model_version, promptVersion: value.prompt_version, supersedesEventId: value.supersedes_event_id });
        json(res, result.idempotent_replay ? 200 : 201, result); return true;
      }
      json(res, 405, { error: { message: 'Method not allowed' } }); return true;
    } catch (error) { json(res, status(error), { error: { message: String(error?.message || error) } }); return true; }
  };
}

