import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { STYLE_FACET_VOCABULARY, normalizeStyleFacetTag } from './template-style-facets-v2.mjs';
import { rebuildTemplateFaceTagProjection } from './face-tag-store.mjs';

const EVENT_VERSION = 'ai-img-gen.template-style-facets-v2-event.v1';
const PROJECTION_VERSION = 'ai-img-gen.template-style-facets-v2-projection.v1';
const TEMPLATE_UID = /^tpl_temp_aiimg_[a-z0-9_-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const writes = new Map();
const transactions = new Map();

function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.values(value).forEach(deepFreeze); return Object.freeze(value); }
function paths(root) { return { events: join(root, 'data', 'events', 'template-style-facets-v2.jsonl'), projection: join(root, 'data', 'projections', 'template-style-facets-v2.json') }; }
async function readJson(path, message) { try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); } catch (error) { if (error.code === 'ENOENT' && message) throw new Error(message); throw error; } }
async function readEvents(path) { try { return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
async function atomicJson(path, value) { const previous = writes.get(path) || Promise.resolve(); const operation = previous.catch(() => {}).then(async () => { await mkdir(dirname(path), { recursive: true }); const tmp = `${path}.${randomUUID()}.tmp`; await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); await rename(tmp, path); }); writes.set(path, operation); try { await operation; } finally { if (writes.get(path) === operation) writes.delete(path); } }
function processAlive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } }
async function acquireFileLock(lockPath, { timeoutMs = 15000, staleMs = 30000 } = {}) { await mkdir(dirname(lockPath), { recursive: true }); const started = Date.now(); while (Date.now() - started < timeoutMs) { try { const handle = await open(lockPath, 'wx'); await handle.writeFile(JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })); await handle.close(); return async () => { await rm(lockPath, { force: true }); }; } catch (error) { if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error; try { const info = await stat(lockPath); if (Date.now() - info.mtimeMs > staleMs) { let owner = null; try { owner = JSON.parse(await readFile(lockPath, 'utf8')); } catch {} if (!owner || !processAlive(Number(owner.pid))) { await rm(lockPath, { force: true }); continue; } } } catch (inspectError) { if (inspectError?.code !== 'ENOENT') throw inspectError; } await new Promise((resolve) => setTimeout(resolve, 20)); } } throw new Error('Template style facet store lock timeout'); }
function assertUid(value) { const uid = String(value || ''); if (!TEMPLATE_UID.test(uid)) throw new Error('Invalid template uid'); return uid; }
function assertHash(value) { const hash = String(value || '').toLowerCase(); if (!SHA256.test(hash)) throw new Error('Invalid template image hash'); return hash; }
function assertKey(value) { const key = String(value || '').trim(); if (!/^[a-zA-Z0-9._:-]{4,128}$/.test(key)) throw new Error('Invalid style facet idempotency key'); return key; }
function projectEvents(events, uid, hash, faceState) {
  let suggestion = null; let confirmation = null;
  for (const event of events) { if (event.template_uid !== uid || event.image_sha256 !== hash) continue; if (event.event_type === 'TemplateStyleFacetsV2Suggested') suggestion = event; if (event.event_type === 'TemplateStyleFacetsV2Confirmed') confirmation = event; }
  const active = faceState === 'active';
  return deepFreeze({ state: active ? (confirmation ? 'confirmed' : suggestion ? 'suggested' : 'untagged') : 'untagged', template_uid: uid, image_sha256: hash, face_tag_state: faceState, eligible: active, suggestion: active ? suggestion : null, confirmation: active ? confirmation : null, facets: active ? (confirmation?.tag || suggestion?.tag || null) : null });
}
async function catalog(root) { const value = await readJson(join(root, 'data', 'projections', 'template-catalog.json'), 'Template catalog not found'); if (!Array.isArray(value.templates)) throw new Error('Template catalog is invalid'); return value; }
async function faceProjection(root) { const eventsPath = join(root, 'data', 'events', 'template-face-tags.jsonl'); try { await stat(eventsPath); await rebuildTemplateFaceTagProjection({ root }); } catch (error) { if (error.code !== 'ENOENT') throw error; } try { return await readJson(join(root, 'data', 'projections', 'template-face-tags.json')); } catch (error) { if (error.code === 'ENOENT') return { templates: {} }; throw error; } }
function faceState(projection, uid) { const item = projection.templates?.[uid]; const tag = item?.confirmation?.tag; if (item?.state === 'confirmed' && tag?.template_state === 'active') return 'active'; if (item?.state === 'confirmed' && ['candidate', 'rejected'].includes(tag?.template_state)) return tag.template_state; return null; }

function validateEvents(events, catalogItems) {
  const byUid = new Map(catalogItems.map((item) => [String(item.template_uid), { uid: assertUid(item.template_uid), hash: assertHash(item.reference_image?.sha256) }]));
  const ids = new Set(); const keys = new Set(); const confirmations = new Map();
  for (const event of events) {
    if (!event || typeof event !== 'object' || event.schema_version !== EVENT_VERSION) throw new Error('Invalid V2 style facet event schema version');
    const allowed = event.event_type === 'TemplateStyleFacetsV2Suggested'
      ? new Set(['schema_version', 'event_id', 'event_type', 'idempotency_key', 'recorded_at', 'actor', 'template_uid', 'image_sha256', 'vocabulary_version', 'tag', 'model_version', 'prompt_version'])
      : new Set(['schema_version', 'event_id', 'event_type', 'idempotency_key', 'recorded_at', 'actor', 'template_uid', 'image_sha256', 'vocabulary_version', 'tag', 'supersedes_event_id']);
    if (Object.keys(event).some((key) => !allowed.has(key))) throw new Error('Unknown V2 style facet event field');
    if (!/^template-style-facets-v2-[a-z0-9-]+$/i.test(String(event.event_id || '')) || ids.has(event.event_id)) throw new Error('Invalid or duplicate V2 style facet event id'); ids.add(event.event_id);
    if (!event.recorded_at || !Number.isFinite(Date.parse(event.recorded_at))) throw new Error('Invalid V2 style facet recorded_at');
    const key = assertKey(event.idempotency_key); if (keys.has(key)) throw new Error('Duplicate V2 style facet idempotency key'); keys.add(key);
    if (!['TemplateStyleFacetsV2Suggested', 'TemplateStyleFacetsV2Confirmed'].includes(event.event_type)) throw new Error('Invalid V2 style facet event type');
    const item = byUid.get(String(event.template_uid)); if (!item || String(event.image_sha256 || '').toLowerCase() !== item.hash) throw new Error('V2 style facet template or image hash mismatch');
    if (event.vocabulary_version !== STYLE_FACET_VOCABULARY.schema_version) throw new Error('Invalid V2 style facet vocabulary version');
    const normalized = normalizeStyleFacetTag(event.tag); if (JSON.stringify(normalized) !== JSON.stringify(event.tag)) throw new Error('V2 style facet tag is not normalized');
    const actor = String(event.actor || '').trim(); if (!actor) throw new Error('V2 style facet actor is required');
    if (event.event_type === 'TemplateStyleFacetsV2Suggested') { if (actor === 'primary-user' || !String(event.model_version || '').trim() || !String(event.prompt_version || '').trim()) throw new Error('V2 suggestion actor, model and prompt are invalid'); if ('supersedes_event_id' in event) throw new Error('V2 suggestion cannot supersede an event'); }
    else { if (actor !== 'primary-user') throw new Error('V2 confirmation actor must be primary-user'); const current = confirmations.get(item.uid) || null; const supersedes = event.supersedes_event_id || null; if (current ? supersedes !== current : supersedes !== null) throw new Error('V2 confirmation supersession chain is invalid'); confirmations.set(item.uid, event.event_id); }
  }
}

export { STYLE_FACET_VOCABULARY };
export async function rebuildTemplateStyleFacetProjection({ root }) { const cat = await catalog(root); const events = await readEvents(paths(root).events); validateEvents(events, cat.templates); const faces = await faceProjection(root); const templates = {}; for (const item of cat.templates) { const uid = assertUid(item.template_uid); const hash = assertHash(item.reference_image?.sha256); templates[uid] = projectEvents(events, uid, hash, faceState(faces, uid)); } const projection = { schema_version: PROJECTION_VERSION, vocabulary_version: STYLE_FACET_VOCABULARY.schema_version, event_count: events.length, templates }; await atomicJson(paths(root).projection, projection); return deepFreeze(projection); }
export async function loadTemplateStyleFacetProjection({ root, templateUid }) { const uid = assertUid(templateUid); const projection = await rebuildTemplateStyleFacetProjection({ root }); if (!projection.templates[uid]) throw new Error('Template not found'); return projection.templates[uid]; }
export async function loadTemplateStyleFacetProgress({ root }) { const projection = await rebuildTemplateStyleFacetProjection({ root }); const result = { total: 0, untagged: 0, suggested: 0, confirmed: 0, active: 0, candidate: 0, rejected: 0 }; for (const item of Object.values(projection.templates)) { result.total += 1; result[item.state] += 1; if (item.face_tag_state && Object.hasOwn(result, item.face_tag_state)) result[item.face_tag_state] += 1; } return result; }
async function recordTemplateStyleFacetUnlocked({ root, templateUid, imageSha256, kind, idempotencyKey, actor, tag, modelVersion = '', promptVersion = '', supersedesEventId = null }) {
  const uid = assertUid(templateUid); const hashInput = assertHash(imageSha256); const cat = await catalog(root); const item = cat.templates.find((entry) => entry.template_uid === uid); if (!item) throw new Error('Template not found'); const hash = assertHash(item.reference_image?.sha256); if (hash !== hashInput) throw new Error('Template image hash mismatch'); if (!['suggestion', 'confirmation'].includes(kind)) throw new Error('Invalid style facet event kind'); const actorValue = String(actor || '').trim(); if (!actorValue) throw new Error('Template style facet actor is required'); if (kind === 'confirmation' && actorValue !== 'primary-user') throw new Error('Template facet confirmation actor must be primary-user'); if (kind === 'suggestion' && (!String(modelVersion).trim() || !String(promptVersion).trim())) throw new Error('Suggestion model and prompt versions are required'); const faces = await faceProjection(root); const state = faceState(faces, uid); if (state !== 'active') throw new Error('Template face tag must be active for style facets'); const normalized = normalizeStyleFacetTag(tag); const eventPath = paths(root); const events = await readEvents(eventPath.events); validateEvents(events, cat.templates); const key = assertKey(idempotencyKey); const replay = events.find((event) => event.idempotency_key === key); const expectedType = kind === 'suggestion' ? 'TemplateStyleFacetsV2Suggested' : 'TemplateStyleFacetsV2Confirmed'; if (replay) { const same = replay.template_uid === uid && replay.image_sha256 === hash && replay.event_type === expectedType && replay.actor === actorValue && JSON.stringify(replay.tag) === JSON.stringify(normalized) && (kind !== 'suggestion' || (replay.model_version === String(modelVersion).trim() && replay.prompt_version === String(promptVersion).trim())) && (kind !== 'confirmation' || (replay.supersedes_event_id || null) === (supersedesEventId || null)); if (!same) throw new Error('Idempotency key conflict'); return { event: replay, projection: projectEvents(events, uid, hash, state), idempotent_replay: true }; } const current = projectEvents(events, uid, hash, state); if (kind === 'confirmation') { const currentId = current.confirmation?.event_id || null; if (currentId && supersedesEventId !== currentId) throw new Error(`Style facet confirmation revision requires supersedes_event_id ${currentId}`); if (!currentId && supersedesEventId) throw new Error('Initial style facet confirmation cannot supersede an event'); }
  const event = { schema_version: EVENT_VERSION, event_id: `template-style-facets-v2-${randomUUID()}`, event_type: kind === 'suggestion' ? 'TemplateStyleFacetsV2Suggested' : 'TemplateStyleFacetsV2Confirmed', idempotency_key: key, recorded_at: new Date().toISOString(), actor: String(actor).trim(), template_uid: uid, image_sha256: hash, vocabulary_version: STYLE_FACET_VOCABULARY.schema_version, tag: normalized, ...(kind === 'suggestion' ? { model_version: String(modelVersion).trim(), prompt_version: String(promptVersion).trim() } : { supersedes_event_id: supersedesEventId || null }) }; await mkdir(dirname(eventPath.events), { recursive: true }); await appendFile(eventPath.events, `${JSON.stringify(event)}\n`, 'utf8'); const projection = await rebuildTemplateStyleFacetProjection({ root }); return { event, projection: projection.templates[uid], idempotent_replay: false };
}

export async function recordTemplateStyleFacet(options) {
  const eventPath = paths(options.root).events;
  const previous = transactions.get(eventPath) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => { const release = await acquireFileLock(`${eventPath}.lock`); try { return await recordTemplateStyleFacetUnlocked(options); } finally { await release(); } });
  transactions.set(eventPath, operation);
  try { return await operation; } finally { if (transactions.get(eventPath) === operation) transactions.delete(eventPath); }
}

// Naming aliases keep the formal page and external callers explicit while retaining one implementation.
export const recordTemplateStyleFacetTag = recordTemplateStyleFacet;
export const loadTemplateStyleFacetsV2Projection = loadTemplateStyleFacetProjection;
export const loadTemplateStyleFacetsV2Progress = loadTemplateStyleFacetProgress;
export const rebuildTemplateStyleFacetsV2Projection = rebuildTemplateStyleFacetProjection;
