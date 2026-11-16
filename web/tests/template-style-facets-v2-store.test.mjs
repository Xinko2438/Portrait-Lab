import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const store = await import('../src/template-style-facets-v2-store.mjs').catch(() => ({}));
const apiModule = await import('../src/template-style-facets-v2-api.mjs').catch(() => ({}));
const ui = await import('../public/template-style-facets-v2-state.js').catch(() => ({}));
const templateUid = 'tpl_temp_aiimg_facets_test_001';
const hash = 'a'.repeat(64);
const activeTag = { template_state: 'active' };
const suggestedTag = { work_type: 'fashion_editorial', treatments: ['monochrome', 'dark_low_key'], positioning: ['luxury'] };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-facets-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'data', 'projections'), { recursive: true });
  await writeFile(join(root, 'data', 'projections', 'template-catalog.json'), `${JSON.stringify({ templates: [{ template_uid: templateUid, reference_image: { sha256: hash } }] })}\n`);
  await writeFile(join(root, 'data', 'projections', 'template-face-tags.json'), `${JSON.stringify({ templates: { [templateUid]: { state: 'confirmed', confirmation: { event_id: 'face-1', tag: activeTag } } } })}\n`);
  return root;
}

test('V2 facets append, rebuild and enforce active face-tag state', async (t) => {
  const root = await fixture(t);
  assert.equal(typeof store.recordTemplateStyleFacet, 'function');
  const saved = await store.recordTemplateStyleFacet({ root, templateUid, imageSha256: hash, kind: 'suggestion', idempotencyKey: 'facet-suggest-1', actor: 'terra', modelVersion: 'gpt-5.6-terra', promptVersion: 'facets-v2', tag: suggestedTag });
  assert.equal(saved.projection.state, 'suggested');
  assert.deepEqual(saved.projection.suggestion.tag, { schema_version: 'ai-img-gen.template-style-facets.v2', ...suggestedTag });
  const rebuilt = await store.rebuildTemplateStyleFacetProjection({ root });
  assert.equal(rebuilt.templates[templateUid].suggestion.event_id, saved.event.event_id);
  assert.equal((await readFile(join(root, 'data', 'events', 'template-style-facets-v2.jsonl'), 'utf8')).trim().split(/\r?\n/).length, 1);
});

test('rejected and nonactive face-tag templates cannot record facets and project null', async (t) => {
  const root = await fixture(t);
  const facePath = join(root, 'data', 'projections', 'template-face-tags.json');
  await writeFile(facePath, JSON.stringify({ templates: { [templateUid]: { state: 'confirmed', confirmation: { event_id: 'face-r', tag: { template_state: 'rejected' } } } } }));
  await assert.rejects(() => store.recordTemplateStyleFacet({ root, templateUid, imageSha256: hash, kind: 'suggestion', idempotencyKey: 'facet-reject-1', actor: 'terra', modelVersion: 'm', promptVersion: 'p', tag: suggestedTag }), /active/i);
  const projection = await store.rebuildTemplateStyleFacetProjection({ root });
  assert.deepEqual(projection.templates[templateUid].facets, null);
});

test('historical facets are hidden after active template becomes rejected and draft is empty', async (t) => {
  const root = await fixture(t);
  await store.recordTemplateStyleFacet({ root, templateUid, imageSha256: hash, kind: 'suggestion', idempotencyKey: 'leak-suggestion-1', actor: 'terra', modelVersion: 'm', promptVersion: 'p', tag: suggestedTag });
  await writeFile(join(root, 'data', 'projections', 'template-face-tags.json'), JSON.stringify({ templates: { [templateUid]: { state: 'confirmed', confirmation: { event_id: 'face-rejected', tag: { template_state: 'rejected' } } } } }));
  const projection = await store.loadTemplateStyleFacetProjection({ root, templateUid });
  assert.equal(projection.suggestion, null);
  assert.equal(projection.confirmation, null);
  assert.equal(projection.facets, null);
  assert.deepEqual(await store.loadTemplateStyleFacetProgress({ root }), { total: 1, untagged: 1, suggested: 0, confirmed: 0, active: 0, candidate: 0, rejected: 1 });
  assert.equal(ui.createTemplateStyleFacetsV2Draft({ projection }).workType, '');
});

test('newer face-tag source event overrides stale face projection during rebuild', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'data', 'events'), { recursive: true });
  const base = { schema_version: 'ai-img-gen.face-tag-event.v1', idempotency_key: 'new-face-event-1', recorded_at: '2026-08-29T00:00:00.000Z', actor: 'primary-user', subject_kind: 'template', subject_id: templateUid, image_sha256: hash, vocabulary_version: 'ai-img-gen.face-tag.v3', event_type: 'FaceTagConfirmed', tag: { schema_version: 'ai-img-gen.face-tag.v3', horizontal: 'front', vertical: 'level', tilt: 'level', eyes: { openness: 'open', gaze: 'camera' }, mouth: 'closed', usability: 'clear', occlusion: { severity: 'none', reasons: [] }, face_scale: 'large', template_state: 'rejected' }, supersedes_event_id: null, event_id: 'face-newer-rejected' };
  await writeFile(join(root, 'data', 'events', 'template-face-tags.jsonl'), `${JSON.stringify(base)}\n`);
  const projection = await store.rebuildTemplateStyleFacetProjection({ root });
  assert.equal(projection.templates[templateUid].face_tag_state, 'rejected');
  assert.equal(projection.templates[templateUid].eligible, false);
});

test('rebuild rejects forged semantic V2 events', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'data', 'events'), { recursive: true });
  const forged = { schema_version: 'ai-img-gen.template-style-facets-v2-event.v1', event_id: 'template-style-facets-v2-forged-1', event_type: 'TemplateStyleFacetsV2Suggested', idempotency_key: 'forged-event-1', recorded_at: '2026-08-29T00:00:00.000Z', actor: 'primary-user', template_uid: templateUid, image_sha256: hash, vocabulary_version: 'ai-img-gen.template-style-facets.v2', tag: suggestedTag, model_version: '', prompt_version: '' };
  await writeFile(join(root, 'data', 'events', 'template-style-facets-v2.jsonl'), `${JSON.stringify(forged)}\n`);
  await assert.rejects(() => store.rebuildTemplateStyleFacetProjection({ root }), /model|prompt|actor|suggestion|normalized/i);
});

test('stale or unconfirmed face projection cannot gate active facets', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'data', 'projections', 'template-face-tags.json'), JSON.stringify({ templates: { [templateUid]: { state: 'suggested', confirmation: { event_id: 'stale', tag: { template_state: 'active' } } } } }));
  await assert.rejects(() => store.recordTemplateStyleFacet({ root, templateUid, imageSha256: hash, kind: 'suggestion', idempotencyKey: 'stale-face-1', actor: 'terra', modelVersion: 'm', promptVersion: 'p', tag: suggestedTag }), /active/i);
  const projection = await store.rebuildTemplateStyleFacetProjection({ root });
  assert.equal(projection.templates[templateUid].face_tag_state, null);
  assert.equal(projection.templates[templateUid].eligible, false);
});

test('confirmation actor is primary-user and concurrent same keys/revisions serialize', async (t) => {
  const root = await fixture(t);
  await assert.rejects(() => store.recordTemplateStyleFacet({ root, templateUid, imageSha256: hash, kind: 'confirmation', idempotencyKey: 'bad-actor-1', actor: 'terra', tag: suggestedTag }), /primary-user/i);
  const results = await Promise.all(Array.from({ length: 8 }, () => store.recordTemplateStyleFacet({ root, templateUid, imageSha256: hash, kind: 'suggestion', idempotencyKey: 'parallel-key-1', actor: 'terra', modelVersion: 'm', promptVersion: 'p', tag: suggestedTag })));
  assert.equal(results.filter((result) => result.idempotent_replay).length, 7);
  assert.equal((await readFile(join(root, 'data', 'events', 'template-style-facets-v2.jsonl'), 'utf8')).trim().split(/\r?\n/).length, 1);
  const first = await store.recordTemplateStyleFacet({ root, templateUid, imageSha256: hash, kind: 'confirmation', idempotencyKey: 'parallel-confirm-1', actor: 'primary-user', tag: suggestedTag });
  const revisions = await Promise.allSettled(Array.from({ length: 3 }, (_, index) => store.recordTemplateStyleFacet({ root, templateUid, imageSha256: hash, kind: 'confirmation', idempotencyKey: `parallel-revision-${index}`, actor: 'primary-user', supersedesEventId: first.event.event_id, tag: suggestedTag })));
  assert.equal(revisions.filter((result) => result.status === 'fulfilled').length, 1);
});

test('cross-process same idempotency key produces one durable event', async (t) => {
  const root = await fixture(t);
  const moduleUrl = new URL('../src/template-style-facets-v2-store.mjs', import.meta.url).href;
  const script = `import { recordTemplateStyleFacet } from ${JSON.stringify(moduleUrl)}; import { mkdir, readdir, writeFile } from 'node:fs/promises'; import { join } from 'node:path'; const root=process.argv[1]; const total=Number(process.argv[2]); const gate=join(root,'cross-process-gate'); await mkdir(gate,{recursive:true}); await writeFile(join(gate,String(process.pid)), 'ready'); while ((await readdir(gate)).length < total) await new Promise((resolve)=>setTimeout(resolve,10)); recordTemplateStyleFacet({root,templateUid:${JSON.stringify(templateUid)},imageSha256:${JSON.stringify(hash)},kind:'suggestion',idempotencyKey:'cross-process-key-1',actor:'terra',modelVersion:'m',promptVersion:'p',tag:${JSON.stringify(suggestedTag)}}).then((result)=>{ console.log(JSON.stringify({idempotent_replay:result.idempotent_replay,event_id:result.event.event_id})); }).catch((error)=>{ console.error(error.stack||error); process.exitCode=1; });`;
  const total = 48;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, String(total)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(stderr || `child exited ${code}`)));
  });
  const results = await Promise.all(Array.from({ length: total }, run));
  assert.equal(results.filter((item) => item.idempotent_replay === false).length, 1);
  assert.equal(results.filter((item) => item.idempotent_replay === true).length, total - 1);
  const lines = (await readFile(join(root, 'data', 'events', 'template-style-facets-v2.jsonl'), 'utf8')).trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.doesNotThrow(() => JSON.parse(lines[0]));
});

test('stale malformed lock is recovered safely before recording', async (t) => {
  const root = await fixture(t);
  const lockPath = join(root, 'data', 'events', 'template-style-facets-v2.jsonl.lock');
  await mkdir(join(root, 'data', 'events'), { recursive: true });
  await writeFile(lockPath, '{malformed', 'utf8');
  const stale = new Date(Date.now() - 120000);
  await utimes(lockPath, stale, stale);
  const saved = await store.recordTemplateStyleFacet({ root, templateUid, imageSha256: hash, kind: 'suggestion', idempotencyKey: 'stale-lock-recovery-1', actor: 'terra', modelVersion: 'm', promptVersion: 'p', tag: suggestedTag });
  assert.equal(saved.idempotent_replay, false);
  assert.equal((await readFile(join(root, 'data', 'events', 'template-style-facets-v2.jsonl'), 'utf8')).trim().split(/\r?\n/).length, 1);
});

test('idempotency replay detects conflicts and confirmation revisions require exact supersedes', async (t) => {
  const root = await fixture(t);
  const first = await store.recordTemplateStyleFacet({ root, templateUid, imageSha256: hash, kind: 'confirmation', idempotencyKey: 'facet-confirm-1', actor: 'primary-user', tag: suggestedTag });
  const replay = await store.recordTemplateStyleFacet({ root, templateUid, imageSha256: hash, kind: 'confirmation', idempotencyKey: 'facet-confirm-1', actor: 'primary-user', tag: suggestedTag });
  assert.equal(replay.idempotent_replay, true);
  await assert.rejects(() => store.recordTemplateStyleFacet({ root, templateUid, imageSha256: hash, kind: 'confirmation', idempotencyKey: 'facet-confirm-1', actor: 'primary-user', tag: { ...suggestedTag, work_type: 'graphic_poster' } }), /idempotency|conflict/i);
  await assert.rejects(() => store.recordTemplateStyleFacet({ root, templateUid, imageSha256: hash, kind: 'confirmation', idempotencyKey: 'facet-confirm-2', actor: 'primary-user', tag: suggestedTag }), /supersedes/i);
  const revised = await store.recordTemplateStyleFacet({ root, templateUid, imageSha256: hash, kind: 'confirmation', idempotencyKey: 'facet-confirm-2', actor: 'primary-user', supersedesEventId: first.event.event_id, tag: { ...suggestedTag, work_type: 'graphic_poster' } });
  assert.equal(revised.projection.confirmation.supersedes_event_id, first.event.event_id);
});

test('progress and API expose vocabulary and facet events', async (t) => {
  const root = await fixture(t);
  const handler = apiModule.createTemplateStyleFacetsV2ApiHandler({ root });
  const server = http.createServer(async (req, res) => { if (!(await handler(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/template-style-facets-v2/vocabulary`)).status, 200);
  assert.equal((await fetch(`${base}/api/template-style-facets-v2/progress`)).status, 200);
  const response = await fetch(`${base}/api/templates/${templateUid}/style-facets-v2`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'suggestion', image_sha256: hash, idempotency_key: 'api-facet-1', actor: 'terra', model_version: 'm', prompt_version: 'p', tag: suggestedTag }) });
  assert.equal(response.status, 201);
  const loaded = await fetch(`${base}/api/templates/${templateUid}/style-facets-v2`).then((r) => r.json());
  assert.equal(loaded.projection.suggestion.tag.work_type, 'fashion_editorial');
});

test('draft gives confirmation precedence, suggestion preselection and bounded toggles', () => {
  assert.equal(typeof ui.createTemplateStyleFacetsV2Draft, 'function');
  const draft = ui.createTemplateStyleFacetsV2Draft({ projection: { suggestion: { event_id: 's1', tag: suggestedTag }, confirmation: null } });
  assert.equal(draft.workType, 'fashion_editorial');
  assert.deepEqual(draft.treatments, ['monochrome', 'dark_low_key']);
  const changed = ui.toggleTemplateStyleFacet(draft, 'treatments', 'bright_high_key');
  assert.equal(changed.treatments.length, 3);
  const unchanged = ui.toggleTemplateStyleFacet(changed, 'treatments', 'retro_film');
  assert.equal(unchanged.treatments.length, 3);
  const confirmed = ui.createTemplateStyleFacetsV2Draft({ projection: { suggestion: { tag: suggestedTag }, confirmation: { event_id: 'c1', tag: { ...suggestedTag, work_type: 'graphic_poster', treatments: [], positioning: [] } } } });
  assert.equal(confirmed.workType, 'graphic_poster');
  const payload = ui.buildTemplateStyleFacetsV2ConfirmationPayload({ draft: confirmed, imageSha256: hash, idempotencyKey: 'ui-facet-1' });
  assert.equal(payload.actor, 'primary-user');
  assert.equal(payload.supersedes_event_id, 'c1');
  assert.equal(payload.tag.work_type, 'graphic_poster');
  assert.throws(() => ui.updateTemplateStyleFacetsV2Draft(confirmed, { workType: 'unknown_work' }), /work type/i);
  assert.throws(() => ui.updateTemplateStyleFacetsV2Draft(confirmed, { treatments: ['monochrome', 'monochrome'] }), /duplicate/i);
  assert.throws(() => ui.buildTemplateStyleFacetsV2ConfirmationPayload({ draft: { ...confirmed, treatments: ['monochrome', 'dark_low_key', 'bright_high_key', 'vivid_color'] }, imageSha256: hash, idempotencyKey: 'overflow-1' }), /three/i);
});
