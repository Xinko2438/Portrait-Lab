import { resolveSmartTask } from './smart-task-state.js';
import { evaluateScores } from './engine.js';
import { canCompareArtifact } from './review-workspace-state.js';
import { face, style } from './demo-vocabulary.js';

const identityImage = {
  url: '/folio/portrait-lab/demo-case/travel-input-af8b6de70ab7.jpg',
  sha256: 'af8b6de70ab778f97a830b81cf06754cb3c780a42f7daf3493fda22b7c41840d',
};
const templateId = 'tpl_temp_aiimg_portfolio';
const template = {
  template_uid: templateId,
  template_info: { template_name: '蓝色旅行杂志' },
  selection_tags: { style_category: 'fashion_editorial', portrait_scale: 'bust' },
  reference_image: { url: '/folio/portrait-lab/demo-case/travel-template-3097a7e33760.jpg', sha256: '3097a7e33760bea8bb01c793c18f77c5f303c2aae3f7cd62ad85989330b262f8' },
};
const customer = { customer_id: 'cust_0000000000000001', display_name: '示例客户' };
const artifacts = [1, 2].map(ordinal => ({ artifact_id: 'sample-' + ordinal, ordinal, width: 942, height: 1672 }));
const visuals = { enabled: false, endpoint: '', model: '' };
const apiConfig = { configured: false, model: '', baseUrl: '' };
const compilation = { compiled_prompt: '根据示例参考图展示固定候选图。', blocks: [{ block_id: 'validated-identity-transfer' }] };

function makeRun(id, createdAt = new Date().toISOString(), name = customer.display_name) {
  return {
    run_id: id, review_flow: 'score-only-v1', customer_id: customer.customer_id, task_intent: { use_case: 'custom', target_framing: 'follow_template', target_face_angle: 'follow_identity', layout_intent: 'follow_template' }, status: 'artifacts_saved', created_at: createdAt, updated_at: createdAt,
    submission_attempt_count: 1, customer_name: name, artifacts: structuredClone(artifacts),
    image_api: { operation: 'edit', n: 2, quality: 'auto' },
    identity_references: [{ sha256: identityImage.sha256, original_name: '旅行杂志原图.jpg' }],
    template_references: [{ sha256: template.reference_image.sha256, original_name: '示例模板.jpg' }],
    reference_preflight: { state: 'passed', warnings: [] },
    artifact_reviews: {}, artifact_annotations: {}, aesthetic_comparisons: [], preference: null,
  };
}

function makeReview(input) {
  const scores = evaluateScores({ face: input.faceFidelity, natural: input.naturalness, style: input.style });
  return {
    face_identity_fidelity: scores.face, realism_naturalness: scores.natural, style_consistency: scores.style,
    verdict: scores.verdict, review_rubric_version: 'portrait-review-v3-three-score-diagnostics-20260816',
    gate_state: scores.verdict, preference_eligible: scores.preference_eligible,
    diagnostic_codes: input.diagnosticCodes || [], notes: input.notes || '',
  };
}

function initialState() {
  const selected = makeRun('run-demo-selected', '2026-11-20T08:00:00Z');
  const rejected = makeRun('run-demo-rejected', '2026-11-19T08:00:00Z', '示例客户 B');
  delete selected.review_flow;
  delete rejected.review_flow;
  const passed = makeReview({ faceFidelity: 9, naturalness: 9, style: 9 });
  const failed = makeReview({ faceFidelity: 6, naturalness: 8, style: 8 });
  for (const artifact of artifacts) {
    selected.artifact_reviews[artifact.artifact_id] = passed;
    rejected.artifact_reviews[artifact.artifact_id] = failed;
  }
  selected.preference = { decision: 'winner', winner_artifact_id: 'sample-1' };
  rejected.preference = { decision: 'none', winner_artifact_id: null };
  return { runs: [selected, rejected], jobs: {}, selections: {}, explorations: {}, annotations: {}, tags: {}, profiles: {}, styleTag: null };
}

const stateKey = new URL('/folio/portrait-lab/demo-state', self.location.origin).href;
const cacheName = 'portrait-lab-portfolio-session-v1';
function localPhotoKey(setId, ordinal) {
  return stateKey + '/photo/' + setId + '/' + ordinal;
}

function addReviewPreview(state) {
  if (state.scorePreviewInitialized) return;
  state.scorePreviewInitialized = true;
  state.runs.push(makeRun('run-demo-review', undefined, '蓝色旅行杂志 · 新评审'));
}

async function stateAction(request, url) {
  const cache = await caches.open(cacheName);
  const response = await cache.match(stateKey);
  const state = response ? await response.json() : initialState();
  addReviewPreview(state);
  state.runs = state.runs.filter(run => !run.run_id.startsWith('run-demo-api-'));
  for (const run of state.runs) {
    if (run.run_id === 'run-demo-selected' || run.run_id === 'run-demo-rejected') {
      run.identity_references = makeRun(run.run_id).identity_references;
    }
  }
  const createdFiles = [];
  const removedFiles = [];
  let result;
  try {
    result = await handle(request, url, state, cache, createdFiles, removedFiles);
    if (request.method !== 'GET' && result.ok) await cache.put(stateKey, Response.json(state));
  } catch (error) {
    await Promise.all(createdFiles.map(key => cache.delete(key)));
    throw error;
  }
  await Promise.all(removedFiles.map(key => cache.delete(key)));
  return result;
}

async function importHistory(request, state, cache, createdFiles) {
  const form = await request.formData();
  const name = String(form.get('customerName') || '').trim();
  const prompt = String(form.get('prompt') || '').trim();
  const groups = [['identity', 'identity'], ['template', 'templates'], ['result', 'results']]
    .map(([role, field]) => [role, form.getAll(field)]);
  const allowed = ['image/png', 'image/jpeg', 'image/webp'];
  if (!name || !prompt || groups.some(([, files]) => !files.length || files.length > 4 ||
     files.some(file => !allowed.includes(file.type) || !file.size || file.size > 10 * 1024 * 1024))) {
    return failure('填写客户名称和提示词，每组选择 1–4 张图片，每张不超过 10 MB。');
  }
  const id = 'run-archive-' + crypto.randomUUID();
  const run = makeRun(id, undefined, name);
  run.local_archive = true;
  run.image_api = null;
  run.prompt = prompt;
  run.history_import = { batch_label: String(form.get('batchLabel') || '').trim() };
  const stored = [];
  const record = {};
  try {
    for (const [role, files] of groups) {
      record[role] = [];
      for (const [index, file] of files.entries()) {
        const key = localPhotoKey(id + '/' + role, index);
        const bitmap = await createImageBitmap(file);
        const {width, height} = bitmap;
        bitmap.close();
        const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
        const sha256 = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        await cache.put(key, new Response(file, {headers: {'Content-Type': file.type}}));
        stored.push(key);
        record[role].push({ ordinal: index + 1, original_name: file.name, sha256, width, height });
      }
    }
  } catch (error) {
    await Promise.all(stored.map(key => cache.delete(key)));
    throw error;
  }
  createdFiles.push(...stored);
  run.identity_references = record.identity;
  run.template_references = record.template;
  run.artifacts = record.result.map(result => ({ ...result, artifact_id: 'archive-' + result.ordinal }));
  state.runs.unshift(run);
  return Response.json(runData(run));
}

function runData(run) {
  const references = ['identity', 'template'].flatMap(role =>
    run[role + '_references'].map((ref, index) => ({
      role, name: ref.original_name, ordinal: index + 1, sha256: ref.sha256,
      url: '/folio/portrait-lab/api/runs/' + run.run_id + '/references/' + role + '/' + index + '/file',
    })));

  return {
    runId: run.run_id, manifest: run, current_api_config: apiConfig,
    reuse: {
      available: true, source_run_id: run.run_id, channel: 'api', references,
      customer_id: run.customer_id, customer_name: run.customer_name, task_intent: run.task_intent,
      api_settings: { ...run.image_api, model: apiConfig.model, provider: apiConfig.baseUrl },
    },
  };
}

function historyEntry(run) {
  return {
    ...run, artifact_count: run.artifacts.length, identity_count: run.identity_references.length, template_count: run.template_references.length,
    prompt: run.prompt || '蓝色旅行杂志',
    reviewed_count: run.artifacts.filter(item => run.artifact_reviews[item.artifact_id]).length,
    artifacts: run.artifacts.map(artifact => {
      const review = run.artifact_reviews[artifact.artifact_id];
      return { ...artifact, reviewed: Boolean(review), gate_state: review?.gate_state, preference_eligible: review?.preference_eligible };
    }),
  };
}

function failure(message, status = 400) {
  return Response.json({ error: message }, { status });
}

async function serveAsset(name) {
  return fetch('/folio/portrait-lab/assets/' + name);
}

function recommendation(brief) {
  const candidate = {
    template_uid: templateId, template_name: template.template_info.template_name,
    template_info: structuredClone(template.template_info),
    reference_image: structuredClone(template.reference_image),
    selection_tags: structuredClone(template.selection_tags),
    rank: 1, relevance_score: 0.91, style_category: 'fashion_editorial',
  };
  return {
    selection_id: 'demo-' + crypto.randomUUID(),
    status: 'insufficient_candidates',
    task_brief: brief,
    filter_summary: { catalog_total: 1, eligible_count: 1, rejected_count: 0, rejection_counts: {} },
    top4: [candidate], top10: [candidate], ranked_candidates: [candidate], warnings: ['insufficient_candidates'],
  };
}

async function handle(request, url, state, cache, createdFiles, removedFiles) {
  const pathname = url.pathname.slice('/folio/portrait-lab'.length);
  const { method } = request;
  const json = Response.json.bind(Response);
  const [resource, id, member, item, action] = pathname.split('/').slice(2);

  if (pathname === '/api/health') return json({ face_angle_matching: 'unavailable', artifact_revision: 'unavailable' });
  if (pathname === '/api/status') return json({ browser: { ready: false, state: 'not_checked' } });
  if (pathname === '/api/image-api/config' && method === 'GET') return json(apiConfig);
  if (pathname === '/api/customer-visual-analysis/config' && method === 'GET') return json(visuals);
  if (pathname === '/api/customer-visual-analysis' && method === 'POST') {
    return json({ config: visuals, entries: [{ state: 'disabled' }] });
  }
  if (pathname === '/api/customers' && method === 'GET') {
    return json({ customers: Object.values(state.profiles).map(pool => ({
      customer_id: pool.customer_id, display_name: pool.display_name, active_identity_set_id: pool.identity_set_id,
    })) });
  }
  if (resource === 'customers' && member === 'identity-sets' && /^cust_[a-f0-9]{16}$/.test(id)) {
    const pool = state.profiles[id];
    if (!item && method === 'GET') return json({ identity_sets: pool ? [pool] : [] });
    if (!item && method === 'POST') {
      const form = await request.formData();
      const displayName = String(form.get('displayName') || '').trim();
      const files = form.getAll('identity');
      if (!displayName || displayName.length > 80) return failure('请输入有效的客户名称。');
      const allowed = ['image/png', 'image/jpeg', 'image/webp'];
      if (!files.length || files.length > 4 || files.some(file =>
        !allowed.includes(file.type) || !file.size || file.size > 10 * 1024 * 1024)) {
        return failure('请选择 1–4 张 PNG、JPEG 或 WebP 图片，每张不超过 10 MB。');
      }
      const setId = 'ids_' + crypto.randomUUID().replaceAll('-', '').slice(0, 24);
      const references = await Promise.all(files.map(async (file, index) => {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
        return {
          ordinal: index + 1, role: index === 0 ? 'primary_front' : 'supplemental',
          original_name: file.name, sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join(''),
        };
      }));
      const photoPool = { customer_id: id, display_name: displayName, identity_set_id: setId, references };
      const keys = files.map((_, index) => localPhotoKey(setId, index + 1));
      try {
        for (const [index, file] of files.entries()) {
          await cache.put(keys[index], new Response(file, {headers: {'Content-Type': file.type}}));
        }
      } catch (error) {
        await Promise.all(keys.map(key => cache.delete(key)));
        throw error;
      }
      createdFiles.push(...keys);
      if (pool) removedFiles.push(...pool.references.map(reference => localPhotoKey(pool.identity_set_id, reference.ordinal)));
      state.profiles[id] = photoPool;
      return json({ identity_set: photoPool });
    }
    if (pool?.identity_set_id === item && method === 'GET') {
      if (action === 'references' && /\/references\/\d+\/file$/.test(pathname)) {
        const ordinal = Number(pathname.split('/').at(-2));
        if (!pool.references.some(reference => reference.ordinal === ordinal)) return failure('找不到照片。', 404);
        return await cache.match(localPhotoKey(item, ordinal)) || failure('找不到照片。', 404);
      }
      if (action === 'face-tags') return json({ projection: { references: {} } });
    }
  }
  if (pathname === '/api/templates' && method === 'GET') {
    const fields = ['style_category', 'portrait_scale', 'face_angle', 'identity_preservation_risk'];
    const catalog = [template];
    const labels = '时尚杂志 旅行杂志 封面 胸像';
    const query = (url.searchParams.get('q') || '').trim().toLowerCase();
    const matches = catalog.filter(item => {
      const searchable = [item.template_info.template_name, ...Object.values(item.selection_tags), labels].join(' ').toLowerCase();
      return query.split(/\s+/).every(term => searchable.includes(term)) && fields.every(field => {
        const value = url.searchParams.get(field);
        return !value || item.selection_tags[field] === value;
      });
    });
    const filters = Object.fromEntries(fields.map(field => [field, [...new Set(catalog.map(item => item.selection_tags[field]).filter(Boolean))]]));
    return json({ templates: matches, total: matches.length, filters });
  }

  if (pathname === '/api/task-resolutions' && method === 'POST') {
    const form = await request.formData();
    const selected = form.getAll('catalogTemplateUids').includes(templateId);
    const source = state.runs.find(run => run.run_id === form.get('sourceRunId'));
    const reused = source ? JSON.parse(form.get('reuseReferences') || '[]') : [];
    const identityCount = form.getAll('identity').filter(file => file.size > 0).length
      + form.getAll('identityReferenceOrdinals').length + reused.filter(ref => ref.role === 'identity').length;
    const templateCount = form.getAll('templates').filter(file => file.size > 0).length
      + Number(selected) + reused.filter(ref => ref.role === 'template').length;
    const resolution = resolveSmartTask({
      customerId: form.get('customerId'), identityCount, templateCount,
      template: selected ? template : null, manual: JSON.parse(form.get('smartOverrides') || '{}'),
    });
    return json({ resolution, compilation });
  }
  if (pathname === '/api/prompt-compilations' && method === 'POST') return json({ compilation });
  if (resource === 'template-selections') {
    if (!id && method === 'POST') {
      const selection = recommendation((await request.json()).task_brief);
      state.selections[selection.selection_id] = selection;
      return json({ selection });
    }
    const selection = state.selections[id];
    if (selection && method === 'GET') return json({ selection });
    if (selection && member === 'explorations' && method === 'POST') {
      const { exploration_idempotency_key: key } = await request.json();
      if (!key) return failure('缺少演示灵感编号。');
      const stateKey = id + ':' + key;
      state.explorations ||= {};
      if (!state.explorations[stateKey]) {
        state.explorations[stateKey] = {
          slate_id: 'demo-slate-' + crypto.randomUUID(),
          selection_id: id,
          round_index: 0,
          candidates: [],
        };
      }
      return json(state.explorations[stateKey]);
    }
    if (selection && member === 'decisions' && method === 'POST') return json({ selection, decision: await request.json() });
  }

  if (resource === 'image-api' && id === 'jobs' && method !== 'GET') {
    return failure('生成服务未连接。', 409);
  }

  if (pathname === '/api/history/import' && method === 'POST') return importHistory(request, state, cache, createdFiles);
  if (resource === 'runs' && method === 'GET' && !id) {
    const deleted = url.searchParams.get('history') === 'deleted';
    const artifactsOnly = url.searchParams.get('artifactsOnly') === 'true';
    return json({ runs: state.runs.filter(run => Boolean(run.history_deleted_at) === deleted && (!artifactsOnly || run.artifacts.length)).map(historyEntry) });
  }
  if (resource === 'runs' && id) {
    const run = state.runs.find(entry => entry.run_id === id);
    if (method === 'DELETE' && !member) {
      if ((await request.json()).confirmed !== true) return failure('请先确认永久删除。', 409);
      if (run && !run.artifacts.length) return failure('只可弃用已经保存结果的任务。', 409);
      if (run?.local_archive) {
        for (const [role, entries] of [['identity', run.identity_references], ['template', run.template_references], ['result', run.artifacts]]) {
          removedFiles.push(...entries.map((_, index) => localPhotoKey(id + '/' + role, index)));
        }
      }
      state.runs = state.runs.filter(entry => entry.run_id !== id);
      for (const key of Object.keys(state.annotations)) {
        if (key.startsWith(id + '/')) delete state.annotations[key];
      }
      for (const [key, job] of Object.entries(state.jobs)) {
        if (job.runId === id) state.jobs[key] = { state: 'discarded' };
      }
      return json({ runId: id, discarded: true });
    }
    if (!run) return failure('演示记录不存在。', 404);
    if (method === 'GET' && !member) return json(runData(run));
    if (method === 'POST' && member === 'record') {
      const payload = await request.json();
      const edits = {
        customer_name: String(payload.customerName || '').trim(),
        intended_use: String(payload.intendedUse || '').trim(),
        prompt: String(payload.prompt || '').trim(),
        batch_label: String(payload.batchLabel || '').trim(),
      };
      if (!edits.prompt) return failure('请输入历史提示词说明。');
      run.record_revisions ||= [];
      run.record_revisions.push({
        customer_name: run.customer_name,
        intended_use: run.intended_use,
        prompt: run.prompt || '蓝色旅行杂志',
        batch_label: run.history_import?.batch_label,
      });
      run.customer_name = edits.customer_name;
      run.intended_use = edits.intended_use;
      run.prompt = edits.prompt;
      run.history_import = {...run.history_import, batch_label: edits.batch_label};
      return json({ saved: true });
    }
    if (method === 'PATCH' && member === 'history') {
      const deleted = (await request.json()).deleted === true;
      run.history_deleted_at = deleted ? new Date().toISOString() : null;
      return json({ deleted });
    }
    if (method === 'GET' && member === 'references' && ['identity', 'template'].includes(item)
        && url.pathname.endsWith('/file') && /^\d+$/.test(action)) {
      const index = Number(action);
      if (!run[item + '_references'][index]) return failure('找不到图片。', 404);
      if (run.local_archive) return await cache.match(localPhotoKey(id + '/' + item, index)) || failure('找不到图片。', 404);
      return fetch(item === 'identity' ? identityImage.url : template.reference_image.url);
    }
    const artifact = run.artifacts.find(entry => entry.artifact_id === item);
    if (member === 'artifacts' && artifact) {
      if (method === 'GET' && action === 'file') {
        if (run.local_archive) return await cache.match(localPhotoKey(id + '/result', artifact.ordinal - 1)) || failure('找不到图片。', 404);
        return serveAsset('case-' + artifact.ordinal + '.webp');
      }
      if (method === 'POST' && action === 'review') {
        const input = await request.json();
        if (run.review_flow === 'score-only-v1' &&
            !['faceFidelity', 'naturalness', 'style'].every(key => typeof input[key] === 'number' &&
              Number.isFinite(input[key]) && input[key] >= 0 && input[key] <= 10 && Math.abs(input[key] * 10 - Math.round(input[key] * 10)) < 1e-8)) {
          return failure('请为这张照片填写完整的三项评分。');
        }
        run.artifact_reviews[item] = makeReview(input);
        if (run.preference?.winner_artifact_id === item && !run.artifact_reviews[item].preference_eligible) {
          run.preference = null;
          run.status = 'artifacts_saved';
        }
        return json({ review: run.artifact_reviews[item] });
      }
    }
    if (member === 'artifacts' && artifact && action === 'annotations' && pathname.endsWith('/latest')) {
      const key = id + '/' + item;
      if (method === 'GET') return json(state.annotations[key] || { annotation: null, state: null });
      if (method === 'POST') {
        const payload = JSON.parse((await request.formData()).get('state'));
        const annotation = { annotation_count: payload.annotations.length, session_id: crypto.randomUUID() };
        const saved = { annotation, state: payload };
        state.annotations[key] = saved;
        run.artifact_annotations[item] = annotation;
        return json(saved);
      }
    }
    if (method === 'POST' && member === 'comparison') {
      const { artifactAId, artifactBId, outcome, notes } = await request.json();
      const pair = [artifactAId, artifactBId].map(key => run.artifacts.find(item => item.artifact_id === key));
      if (artifactAId === artifactBId || pair.some(item => !item || !canCompareArtifact(run, item))) {
        return failure('请选择两张可比较的照片。');
      }
      if (run.review_flow === 'score-only-v1') {
        if (!['a','b','tie','skip','clear'].includes(outcome)) return failure('不支持的比较结果。');
      }
      run.aesthetic_comparisons.push({ artifact_a_id: artifactAId, artifact_b_id: artifactBId, outcome, notes });
      return json({ comparisonCount: run.aesthetic_comparisons.length });
    }
    if (method === 'POST' && member === 'preference') {
      if (run.review_flow === 'score-only-v1') return failure('这条任务使用评分流程。', 409);
      const { decision, winnerArtifactId, notes } = await request.json();
      if (decision !== 'pending' && !run.artifacts.every(entry => run.artifact_reviews[entry.artifact_id])) {
        return failure('请先完成逐图评分。');
      }
      if (decision === 'winner' && !run.artifact_reviews[winnerArtifactId]?.preference_eligible) return failure('请选择合格候选。');
      run.preference = { decision, winner_artifact_id: winnerArtifactId, notes };
      run.status = decision === 'pending' ? 'artifacts_saved' : 'completed';
      return json({ preference: run.preference });
    }
  }

  if (pathname === '/api/face-tags/vocabulary') return json({ vocabulary: face });
  if (pathname === '/api/template-style-facets-v2/vocabulary') return json({ vocabulary: style });
  const tagged = Boolean(state.tags[templateId]);
  if (pathname === '/api/face-tags/templates/statuses') {
    return json({ statuses: { items: [{ template_uid: templateId, filter_state: state.tags[templateId]?.confirmation.tag.template_state || 'untagged' }] } });
  }
  if (pathname === '/api/face-tags/templates/progress') {
    return json({ progress: { confirmed: Number(tagged), total: 1, untagged: Number(!tagged) } });
  }
  if (resource === 'templates' && id === templateId && ['face-tag', 'style-facets-v2'].includes(member)) {
    if (method === 'GET') return json({ projection: member === 'face-tag' ? state.tags[id] || null : state.styleTag });
    if (method === 'POST') {
      const payload = await request.json();
      const projection = { confirmation: { tag: payload.tag, event_id: crypto.randomUUID() } };
      if (member === 'face-tag') state.tags[id] = projection;
      else state.styleTag = projection;
      return json({ projection });
    }
  }
  return failure('此操作当前不可用。', 501);
}

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

let pending = Promise.resolve();
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/folio/portrait-lab/api/')) return;
  const response = pending.then(() => stateAction(event.request, url)).catch(error => failure(error.message));
  pending = response.then(() => undefined);
  event.respondWith(response);
});
