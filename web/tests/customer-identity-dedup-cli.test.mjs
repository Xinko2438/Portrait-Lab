import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = await import('../scripts/customer-identity-dedup.mjs').catch(() => ({}));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'identity-dedup-cli-'));
  const customerId = 'cust_0123456789abcdef';
  const customerRoot = join(root, 'data', 'customers', customerId);
  const setsRoot = join(customerRoot, 'identity-sets');
  await mkdir(setsRoot, { recursive: true });
  const ids = ['ids_111111111111111111111111', 'ids_222222222222222222222222', 'ids_333333333333333333333333'];
  for (let index = 0; index < ids.length; index += 1) {
    const dir = join(setsRoot, ids[index]);
    await mkdir(join(dir, 'references'), { recursive: true });
    await writeFile(join(dir, 'references', '01-primary_front.png'), png);
    await writeFile(join(dir, 'identity-set.json'), `${JSON.stringify({ schema_version: 'ai-img-gen.customer-identity-set.v1', customer_id: customerId, identity_set_id: ids[index], version: index + 1, state: 'active', display_name: 'Test', coverage: ['primary_front'], references: [{ ordinal: 1, role: 'primary_front', filename: '01-primary_front.png', original_name: 'front.png', sha256: '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460', bytes: png.length, width: 1, height: 1, mime_type: 'image/png', extension: '.png' }], created_at: '2026-08-25T00:00:00.000Z', updated_at: '2026-08-25T00:00:00.000Z' }, null, 2)}\n`);
  }
  const customer = { schema_version: 'ai-img-gen.customer.v1', customer_id: customerId, display_name: 'Test', active_identity_set_id: ids[2], identity_set_count: 3, latest_identity_set_version: 3, created_at: '2026-08-25T00:00:00.000Z', updated_at: '2026-08-25T00:00:00.000Z' };
  await writeFile(join(customerRoot, 'customer.json'), `${JSON.stringify(customer, null, 2)}\n`);
  await writeFile(join(customerRoot, 'events.jsonl'), '');
  await mkdir(join(root, 'data', 'runs'), { recursive: true });
  return { root, customerId, ids, customer };
}

test('dedup apply archives exact copies, deletes duplicates, updates projection, and appends evidence', async () => {
  assert.equal(typeof cli.previewIdentityDedup, 'function');
  assert.equal(typeof cli.applyIdentityDedup, 'function');
  const { root, customerId, ids } = await fixture();
  const archiveRoot = join(root, 'archive', 'customer-identity-dedup', '20260825');
  const preview = await cli.previewIdentityDedup({ root, customerId, archiveRoot });
  assert.deepEqual(preview.plan.duplicate_identity_set_ids.sort(), ids.slice(0, 2).sort());
  const applied = await cli.applyIdentityDedup({ root, customerId, archiveRoot, expectedGroupHash: preview.plan.group_hash });
  assert.equal(applied.deleted_count, 2);
  const customer = JSON.parse(await readFile(join(root, 'data', 'customers', customerId, 'customer.json'), 'utf8'));
  assert.equal(customer.active_identity_set_id, ids[2]);
  assert.equal(customer.identity_set_count, 1);
  assert.equal(customer.latest_identity_set_version, 3);
  const manifest = JSON.parse(await readFile(applied.archive_manifest_path, 'utf8'));
  assert.equal(manifest.entries.length, 2);
  assert.equal(manifest.source_and_archive_hashes_match, true);
  assert.match(await readFile(join(root, 'data', 'customers', customerId, 'events.jsonl'), 'utf8'), /CustomerIdentitySetsDeduplicated/);
});

test('dedup restore recreates deleted directories and restores the prior customer projection', async () => {
  assert.equal(typeof cli.restoreIdentityDedup, 'function');
  const { root, customerId, ids, customer } = await fixture();
  const archiveRoot = join(root, 'archive', 'customer-identity-dedup', '20260825');
  const preview = await cli.previewIdentityDedup({ root, customerId, archiveRoot });
  const applied = await cli.applyIdentityDedup({ root, customerId, archiveRoot, expectedGroupHash: preview.plan.group_hash });
  const restored = await cli.restoreIdentityDedup({ root, archiveManifestPath: applied.archive_manifest_path });
  assert.equal(restored.restored_count, 2);
  for (const id of ids) assert.equal((await readFile(join(root, 'data', 'customers', customerId, 'identity-sets', id, 'identity-set.json'), 'utf8')).length > 0, true);
  const projected = JSON.parse(await readFile(join(root, 'data', 'customers', customerId, 'customer.json'), 'utf8'));
  assert.deepEqual(projected, customer);
});

test('dedup apply fails closed when a duplicate is referenced by a Run', async () => {
  const { root, customerId, ids } = await fixture();
  await writeFile(join(root, 'data', 'runs', 'run-reference.json'), JSON.stringify({ customer_identity_source: { identity_set_id: ids[0] } }));
  const archiveRoot = join(root, 'archive', 'customer-identity-dedup', '20260825');
  const preview = await cli.previewIdentityDedup({ root, customerId, archiveRoot });
  assert.equal(preview.plan.blocked.length, 1);
  await assert.rejects(() => cli.applyIdentityDedup({ root, customerId, archiveRoot, expectedGroupHash: preview.plan.group_hash }), /blocked/i);
});