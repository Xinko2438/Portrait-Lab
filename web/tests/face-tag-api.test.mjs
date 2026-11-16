import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let apiModule = {};
try {
  apiModule = await import('../src/face-tag-api.mjs');
} catch {
  apiModule = {};
}

const templateUid = 'tpl_temp_aiimg_test_001';
const customerId = 'cust_1111111111111111';
const identitySetId = 'ids_222222222222222222222222';
const templateBytes = Buffer.from('template-face');
const identityOne = Buffer.from('identity-one');
const identityTwo = Buffer.from('identity-two');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const templateTag = {
  horizontal: 'image_left_slight',
  vertical: 'slight_down',
  tilt: 'slight_right',
  eyes: { openness: 'closed', gaze: 'not_applicable' },
  mouth: 'closed',
  usability: 'clear',
  occlusion: { severity: 'none', reasons: [] },
  face_scale: 'large',
  template_state: 'active',
};

const identityTag = {
  horizontal: 'image_left_slight',
  vertical: 'slight_down',
  tilt: 'slight_right',
  eyes: { openness: 'closed', gaze: 'not_applicable' },
  mouth: 'closed',
  usability: 'clear',
  occlusion: { severity: 'none', reasons: [] },
  face_scale: 'large',
};

async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-face-tag-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const templateDir = join(root, 'data', 'templates', templateUid);
  await mkdir(templateDir, { recursive: true });
  await writeFile(join(templateDir, 'reference.png'), templateBytes);
  await mkdir(join(root, 'data', 'projections'), { recursive: true });
  await writeFile(join(root, 'data', 'projections', 'template-catalog.json'), `${JSON.stringify({
    schema_version: 'ai-img-gen.template-catalog.v1',
    templates: [{
      template_uid: templateUid,
      template_info: { template_name: '测试模板' },
      reference_image_path: `data/templates/${templateUid}/reference.png`,
      reference_image: { sha256: sha256(templateBytes), mime_type: 'image/png' },
    }],
  })}\n`, 'utf8');
  const setRoot = join(root, 'data', 'customers', customerId, 'identity-sets', identitySetId);
  await mkdir(join(setRoot, 'references'), { recursive: true });
  await writeFile(join(setRoot, 'references', '01-front.png'), identityOne);
  await writeFile(join(setRoot, 'references', '02-closed.png'), identityTwo);
  await writeFile(join(setRoot, 'identity-set.json'), `${JSON.stringify({
    schema_version: 'ai-img-gen.customer-identity-set.v1',
    customer_id: customerId,
    identity_set_id: identitySetId,
    state: 'active',
    references: [
      { ordinal: 1, filename: '01-front.png', original_name: 'front.png', sha256: sha256(identityOne) },
      { ordinal: 2, filename: '02-closed.png', original_name: 'closed.png', sha256: sha256(identityTwo) },
    ],
  })}\n`, 'utf8');
  return root;
}

async function startApi(root) {
  assert.equal(typeof apiModule.createFaceTagApiHandler, 'function');
  const handler = apiModule.createFaceTagApiHandler({ root });
  const server = http.createServer(async (req, res) => {
    if (!(await handler(req, res))) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function request(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') || '';
  return { status: response.status, body: contentType.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()), contentType };
}

test('face tag API exposes vocabulary, template progress, suggestion, confirmation, and idempotent replay', async (t) => {
  const root = await makeRoot(t);
  const api = await startApi(root);
  try {
    const vocabulary = await request(`${api.base}/api/face-tags/vocabulary`);
    assert.equal(vocabulary.status, 200);
    assert.equal(vocabulary.body.vocabulary.horizontal[0].label, '完整朝左');
    assert.equal((await request(`${api.base}/api/face-tags/templates/progress`)).body.progress.untagged, 1);
    const initialStatuses = await request(`${api.base}/api/face-tags/templates/statuses`);
    assert.equal(initialStatuses.status, 200);
    assert.equal(initialStatuses.body.statuses.items[0].filter_state, 'untagged');

    const suggestionPayload = {
      kind: 'suggestion',
      image_sha256: sha256(templateBytes),
      idempotency_key: 'api-suggestion-001',
      actor: 'terra',
      model_version: 'gpt-5.6-terra',
      prompt_version: 'face-tag-preselect-v1',
      tag: { ...templateTag, template_state: 'candidate' },
    };
    const suggested = await request(`${api.base}/api/templates/${templateUid}/face-tag`, { method: 'POST', body: suggestionPayload });
    assert.equal(suggested.status, 201);
    assert.equal(suggested.body.projection.state, 'suggested');
    assert.equal((await request(`${api.base}/api/face-tags/templates/progress`)).body.progress.confirmed, 0);

    const confirmPayload = {
      kind: 'confirmation',
      image_sha256: sha256(templateBytes),
      idempotency_key: 'api-confirm-001',
      actor: 'primary-user',
      tag: templateTag,
    };
    const confirmed = await request(`${api.base}/api/templates/${templateUid}/face-tag`, { method: 'POST', body: confirmPayload });
    assert.equal(confirmed.status, 201);
    assert.equal(confirmed.body.projection.state, 'confirmed');
    const replay = await request(`${api.base}/api/templates/${templateUid}/face-tag`, { method: 'POST', body: confirmPayload });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotent_replay, true);
    assert.equal((await request(`${api.base}/api/templates/${templateUid}/face-tag`)).body.projection.confirmation.event_id, confirmed.body.event.event_id);
    const finalStatuses = await request(`${api.base}/api/face-tags/templates/statuses`);
    assert.equal(finalStatuses.body.statuses.items[0].filter_state, 'active');
    assert.equal(finalStatuses.body.statuses.items[0].confirmation_event_id, confirmed.body.event.event_id);
  } finally {
    await api.close();
  }
});

test('identity API confirms exact scoped references, serves bytes, and denies cross-customer access', async (t) => {
  const root = await makeRoot(t);
  const api = await startApi(root);
  try {
    const saved = await request(`${api.base}/api/customers/${customerId}/identity-sets/${identitySetId}/references/2/face-tag`, {
      method: 'POST',
      body: {
        kind: 'confirmation',
        image_sha256: sha256(identityTwo),
        idempotency_key: 'identity-api-001',
        actor: 'primary-user',
        tag: identityTag,
      },
    });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.projection.confirmation.tag.eyes.gaze, 'not_applicable');
    const listed = await request(`${api.base}/api/customers/${customerId}/identity-sets/${identitySetId}/face-tags`);
    assert.equal(listed.body.projection.references['2'].state, 'confirmed');
    const file = await request(`${api.base}/api/customers/${customerId}/identity-sets/${identitySetId}/references/2/file`);
    assert.equal(file.status, 200);
    assert.deepEqual(file.body, identityTwo);
    const denied = await request(`${api.base}/api/customers/cust_9999999999999999/identity-sets/${identitySetId}/face-tags`);
    assert.equal(denied.status, 404);
    const badOrdinal = await request(`${api.base}/api/customers/${customerId}/identity-sets/${identitySetId}/references/9/file`);
    assert.equal(badOrdinal.status, 404);
  } finally {
    await api.close();
  }
});

test('local match route returns manual required before confirmations and selects the closest confirmed reference', async (t) => {
  const root = await makeRoot(t);
  const api = await startApi(root);
  const matchUrl = `${api.base}/api/face-tags/match`;
  try {
    const requestBody = { template_uid: templateUid, customer_id: customerId, identity_set_id: identitySetId };
    const before = await request(matchUrl, { method: 'POST', body: requestBody });
    assert.equal(before.status, 200);
    assert.equal(before.body.result.state, 'manual_required');

    await request(`${api.base}/api/templates/${templateUid}/face-tag`, { method: 'POST', body: {
      kind: 'confirmation', image_sha256: sha256(templateBytes), idempotency_key: 'match-template', actor: 'primary-user', tag: templateTag,
    } });
    await request(`${api.base}/api/customers/${customerId}/identity-sets/${identitySetId}/references/1/face-tag`, { method: 'POST', body: {
      kind: 'confirmation', image_sha256: sha256(identityOne), idempotency_key: 'match-identity-1', actor: 'primary-user', tag: { ...identityTag, horizontal: 'image_right_strong', eyes: { openness: 'open', gaze: 'camera' } },
    } });
    await request(`${api.base}/api/customers/${customerId}/identity-sets/${identitySetId}/references/2/face-tag`, { method: 'POST', body: {
      kind: 'confirmation', image_sha256: sha256(identityTwo), idempotency_key: 'match-identity-2', actor: 'primary-user', tag: identityTag,
    } });
    const matched = await request(matchUrl, { method: 'POST', body: requestBody });
    assert.equal(matched.status, 200);
    assert.equal(matched.body.result.state, 'matched');
    assert.equal(matched.body.result.selected.ordinal, 2);
    assert.deepEqual(matched.body.result.ranked.map((item) => item.ordinal), [2, 1]);
  } finally {
    await api.close();
  }
});

test('face tag API returns conflict for stale template hashes and revisions', async (t) => {
  const root = await makeRoot(t);
  const api = await startApi(root);
  try {
    const staleHash = await request(`${api.base}/api/templates/${templateUid}/face-tag`, { method: 'POST', body: {
      kind: 'confirmation', image_sha256: 'f'.repeat(64), idempotency_key: 'stale-hash', actor: 'primary-user', tag: templateTag,
    } });
    assert.equal(staleHash.status, 409);
    const first = await request(`${api.base}/api/templates/${templateUid}/face-tag`, { method: 'POST', body: {
      kind: 'confirmation', image_sha256: sha256(templateBytes), idempotency_key: 'stale-first', actor: 'primary-user', tag: templateTag,
    } });
    assert.equal(first.status, 201);
    const staleRevision = await request(`${api.base}/api/templates/${templateUid}/face-tag`, { method: 'POST', body: {
      kind: 'confirmation', image_sha256: sha256(templateBytes), idempotency_key: 'stale-second', actor: 'primary-user', tag: { ...templateTag, template_state: 'rejected' },
    } });
    assert.equal(staleRevision.status, 409);
  } finally {
    await api.close();
  }
});
