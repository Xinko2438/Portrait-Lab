import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createIdentitySet } from '../src/customer-identity-store.mjs';

const customerIdentityStore = await import('../src/customer-identity-store.mjs').catch(() => ({}));
const appendIdentitySet = customerIdentityStore.appendIdentitySet || (async () => { throw new Error('appendIdentitySet is not implemented'); });

const customerId = 'cust_1111111111111111';
const otherCustomerId = 'cust_2222222222222222';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function png(width, height, marker = 0) {
  const bytes = Buffer.alloc(25);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = marker;
  return bytes;
}

function identityFiles(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    name: `identity-${offset + index + 1}.png`,
    bytes: png(offset + index + 1, offset + index + 2, offset + index + 1),
    role: index === 0 && offset === 0 ? 'primary_front' : 'identity_support',
  }));
}

async function fixture(t, { count = 3 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-pool-append-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = await createIdentitySet({
    root,
    customerId,
    displayName: '测试客户',
    files: identityFiles(count),
  });
  return { root, parent };
}

async function treeFiles(path, base = path) {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    const current = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await treeFiles(current, base));
    else files.push({ path: current.slice(base.length + 1), bytes: await readFile(current) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

test('append creates an immutable successor with exact parent references, support-role additions, and append lineage', async (t) => {
  const { root, parent } = await fixture(t);
  const parentDir = join(root, 'data', 'customers', customerId, 'identity-sets', parent.identity_set_id);
  const parentBefore = await treeFiles(parentDir);
  const added = identityFiles(2, 10);

  const result = await appendIdentitySet({ root, customerId, identitySetId: parent.identity_set_id, files: added });

  assert.equal(result.appended_count, 2);
  assert.equal(result.duplicate_count, 0);
  assert.equal(result.no_changes, false);
  assert.notEqual(result.identity_set.identity_set_id, parent.identity_set_id);
  assert.equal(result.identity_set.parent_identity_set_id, parent.identity_set_id);
  assert.equal(result.identity_set.change_type, 'append');
  assert.equal(result.identity_set.version, parent.version + 1);
  assert.deepEqual(result.identity_set.references.slice(0, parent.references.length), parent.references);
  assert.deepEqual(result.identity_set.references.slice(parent.references.length).map((item) => item.role), ['identity_support', 'identity_support']);
  assert.deepEqual(result.identity_set.references.map((item) => item.ordinal), [1, 2, 3, 4, 5]);
  assert.deepEqual(await treeFiles(parentDir), parentBefore);

  const successorDir = join(root, 'data', 'customers', customerId, 'identity-sets', result.identity_set.identity_set_id);
  for (let index = 0; index < parent.references.length; index += 1) {
    const reference = parent.references[index];
    assert.deepEqual(await readFile(join(successorDir, 'references', reference.filename)), parentBefore.find((item) => item.path === `references\\${reference.filename}`)?.bytes);
  }
  const successorFiles = await treeFiles(join(successorDir, 'references'));
  assert.deepEqual(successorFiles.slice(-2).map((item) => hash(item.bytes)), added.map((item) => hash(item.bytes)));

  const customer = JSON.parse(await readFile(join(root, 'data', 'customers', customerId, 'customer.json'), 'utf8'));
  assert.equal(customer.active_identity_set_id, result.identity_set.identity_set_id);
  const events = (await readFile(join(root, 'data', 'customers', customerId, 'events.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(events.at(-1).data.parent_identity_set_id, parent.identity_set_id);
  assert.equal(events.at(-1).data.change_type, 'append');
  assert.deepEqual(events.at(-1).data.appended_reference_hashes, added.map((item) => hash(item.bytes)));
  await assert.rejects(access(join(root, 'data', 'runs')));
});

test('append deduplicates by SHA-256 across parent and batch, reports counts, and makes all-duplicate requests write nothing', async (t) => {
  const { root, parent } = await fixture(t, { count: 2 });
  const unique = identityFiles(1, 10)[0];
  const mixed = await appendIdentitySet({
    root,
    customerId,
    identitySetId: parent.identity_set_id,
    files: [
      { name: 'renamed-existing.png', bytes: identityFiles(2)[1].bytes },
      unique,
      { name: 'same-new-bytes.png', bytes: unique.bytes },
    ],
  });
  assert.equal(mixed.appended_count, 1);
  assert.equal(mixed.duplicate_count, 2);
  assert.equal(mixed.identity_set.references.length, 3);
  assert.equal(mixed.identity_set.references[0].role, 'primary_front');
  assert.equal(mixed.identity_set.references[2].role, 'identity_support');

  const customerRoot = join(root, 'data', 'customers', customerId);
  const beforeReplay = await treeFiles(customerRoot);
  const replay = await appendIdentitySet({ root, customerId, identitySetId: parent.identity_set_id, files: [unique] });
  assert.equal(replay.identity_set.identity_set_id, mixed.identity_set.identity_set_id);
  assert.equal(replay.no_changes, true);
  assert.deepEqual(await treeFiles(customerRoot), beforeReplay);

  const before = await treeFiles(customerRoot);
  const duplicateOnly = await appendIdentitySet({
    root,
    customerId,
    identitySetId: mixed.identity_set.identity_set_id,
    files: [unique, { name: 'renamed-primary.png', bytes: identityFiles(2)[0].bytes }],
  });
  assert.equal(duplicateOnly.identity_set.identity_set_id, mixed.identity_set.identity_set_id);
  assert.equal(duplicateOnly.appended_count, 0);
  assert.equal(duplicateOnly.duplicate_count, 2);
  assert.equal(duplicateOnly.no_changes, true);
  assert.deepEqual(await treeFiles(customerRoot), before);
});

test('append validates 1-8 uploads, the 32-reference ceiling, and exact customer/set scope before durable writes', async (t) => {
  const { root, parent } = await fixture(t, { count: 32 });
  const customerRoot = join(root, 'data', 'customers', customerId);
  const before = await treeFiles(customerRoot);

  await assert.rejects(() => appendIdentitySet({ root, customerId, identitySetId: parent.identity_set_id, files: [] }), /at least one/i);
  await assert.rejects(() => appendIdentitySet({ root, customerId, identitySetId: parent.identity_set_id, files: identityFiles(9, 100) }), /at most eight/i);
  await assert.rejects(() => appendIdentitySet({ root, customerId, identitySetId: parent.identity_set_id, files: [{ name: 'broken.png', bytes: Buffer.from('not-an-image') }] }), /png|jpeg|webp|image/i);
  await assert.rejects(() => appendIdentitySet({ root, customerId, identitySetId: parent.identity_set_id, files: identityFiles(1, 100) }), /at most 32/i);
  await assert.rejects(() => appendIdentitySet({ root, customerId: otherCustomerId, identitySetId: parent.identity_set_id, files: identityFiles(1, 100) }), /not found/i);
  assert.deepEqual(await treeFiles(customerRoot), before);
  await assert.rejects(access(join(root, 'data', 'customers', otherCustomerId)));
});

async function startIsolatedServer(t, root) {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, AI_IMG_GEN_PORT: '0', AI_IMG_GEN_PROJECT_ROOT: root, AI_IMG_GEN_AI_PROMPT_WRITER_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => child.exitCode === null ? child.once('exit', resolve) : resolve());
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Isolated server did not report a port: ${stdout}${stderr}`)), 3_000);
    const inspect = () => {
      const assigned = Number(stdout.match(/AI IMG GEN web: http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
      if (!Number.isInteger(assigned) || assigned <= 0) return;
      clearTimeout(timer);
      resolve(assigned);
    };
    child.stdout.on('data', inspect);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Isolated server exited early: ${stderr}`)); });
    inspect();
  });
  return `http://127.0.0.1:${port}`;
}

test('actual append HTTP route returns 201/200 counts in exact scope and never creates a Run', async (t) => {
  const { root, parent } = await fixture(t, { count: 2 });
  const base = await startIsolatedServer(t, root);
  const unique = identityFiles(1, 10)[0];
  const form = new FormData();
  form.append('identity', new Blob([identityFiles(2)[1].bytes], { type: 'image/png' }), 'duplicate-renamed.png');
  form.append('identity', new Blob([unique.bytes], { type: 'image/png' }), unique.name);
  const response = await fetch(`${base}/api/customers/${customerId}/identity-sets/${parent.identity_set_id}/append`, { method: 'POST', body: form });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.appended_count, 1);
  assert.equal(created.duplicate_count, 1);
  assert.equal(created.no_changes, false);

  const duplicateForm = new FormData();
  duplicateForm.append('identity', new Blob([unique.bytes], { type: 'image/png' }), 'same-again.png');
  const duplicateResponse = await fetch(`${base}/api/customers/${customerId}/identity-sets/${created.identity_set.identity_set_id}/append`, { method: 'POST', body: duplicateForm });
  assert.equal(duplicateResponse.status, 200);
  assert.equal((await duplicateResponse.json()).no_changes, true);

  const deniedForm = new FormData();
  deniedForm.append('identity', new Blob([identityFiles(1, 20)[0].bytes], { type: 'image/png' }), 'denied.png');
  const denied = await fetch(`${base}/api/customers/${otherCustomerId}/identity-sets/${parent.identity_set_id}/append`, { method: 'POST', body: deniedForm });
  assert.equal(denied.status, 404);
  await assert.rejects(access(join(root, 'data', 'runs')));
});

test('concurrent identical HTTP appends publish exactly one successor event and version', async (t) => {
  const { root, parent } = await fixture(t, { count: 31 });
  const base = await startIsolatedServer(t, root);
  const unique = identityFiles(1, 100)[0];
  const append = () => {
    const form = new FormData();
    form.append('identity', new Blob([unique.bytes], { type: 'image/png' }), unique.name);
    return fetch(`${base}/api/customers/${customerId}/identity-sets/${parent.identity_set_id}/append`, { method: 'POST', body: form });
  };

  const responses = await Promise.all([append(), append()]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
  const results = await Promise.all(responses.map((response) => response.json()));
  assert.equal(new Set(results.map((result) => result.identity_set.identity_set_id)).size, 1);
  assert.equal(results.filter((result) => result.no_changes === false).length, 1);
  assert.equal(results.filter((result) => result.no_changes === true).length, 1);

  const sets = await readdir(join(root, 'data', 'customers', customerId, 'identity-sets'));
  assert.equal(sets.length, 2);
  const versions = await Promise.all(sets.map(async (setId) => JSON.parse(await readFile(join(root, 'data', 'customers', customerId, 'identity-sets', setId, 'identity-set.json'), 'utf8'))));
  assert.deepEqual(versions.map((item) => item.version).sort((a, b) => a - b), [1, 2]);
  const events = (await readFile(join(root, 'data', 'customers', customerId, 'events.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(events.length, 2);
  assert.equal(events.filter((event) => event.data.change_type === 'append').length, 1);
});

test('concurrent same-customer creates allocate distinct monotonic versions under the shared mutation boundary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-pool-create-concurrency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstFiles = identityFiles(16);
  const secondFiles = identityFiles(16, 100).map((file, index) => ({ ...file, role: index === 0 ? 'primary_front' : 'identity_support' }));

  const created = await Promise.all([
    createIdentitySet({ root, customerId, displayName: 'Concurrent Customer', files: firstFiles }),
    createIdentitySet({ root, customerId, displayName: 'Concurrent Customer', files: secondFiles }),
  ]);

  assert.deepEqual(created.map((item) => item.version).sort((a, b) => a - b), [1, 2]);
  assert.equal(new Set(created.map((item) => item.identity_set_id)).size, 2);
  const customer = JSON.parse(await readFile(join(root, 'data', 'customers', customerId, 'customer.json'), 'utf8'));
  assert.equal(customer.identity_set_count, 2);
  assert.equal(customer.latest_identity_set_version, 2);
  const events = (await readFile(join(root, 'data', 'customers', customerId, 'events.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(events.length, 2);
});

test('photo-pool UI exposes hidden multi-file append, busy/error feedback, refreshes the returned set, and has no generation submit in the append flow', async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="appendCustomerPhotosButton"[^>]*>添加照片</);
  assert.match(html, /id="customerPhotoAppendInput"[^>]*type="file"[^>]*multiple[^>]*hidden/);
  const start = app.indexOf('async function appendCustomerPhotos');
  const end = app.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start);
  const flow = app.slice(start, end);
  assert.match(flow, /\/api\/customers\/\$\{encodeURIComponent\(customerId\)\}\/identity-sets\/\$\{encodeURIComponent\(identitySetId\)\}\/append/);
  assert.match(flow, /setBusy\(elements\.appendCustomerPhotosButton/);
  assert.match(flow, /loadFoundationActivePhotoPool\(customerId\)/);
  assert.match(flow, /data\.identity_set\.identity_set_id/);
  assert.match(flow, /customerPhotoPoolMessage\.textContent/);
  assert.doesNotMatch(flow, /\/api\/runs|submitRun|stageAndSubmit/);
  assert.match(css, /\.customer-photo-pool-actions/);
  assert.match(css, /\.customer-photo-append-input/);
});

test('Ctrl+V over an existing customer pool appends clipboard images without entering the pending Run inputs', async () => {
  const [html, app, css] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="customerPhotoPool"[^>]*data-paste-target="customer-pool"[^>]*tabindex="0"/);
  assert.match(html, /照片池区域[^<]*Ctrl\+V/);
  assert.match(app, /\['customer-pool',\s*elements\.customerPhotoPool\]/);
  assert.match(app, /activePasteTarget === 'customer-pool'[\s\S]*appendCustomerPhotos\(files\)/);
  assert.match(app, /customerPhotoPool\.classList\.toggle\('paste-target-active'/);
  assert.match(css, /\.customer-photo-pool\.paste-target-active/);
  assert.doesNotMatch(app, /navigator\.clipboard\.read/);
});
