import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentitySet } from '../src/customer-identity-store.mjs';

const governance = await import('../src/customer-identity-governance.mjs').catch(() => ({}));

const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const whitePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlAT8sAAAAASUVORK5CYII=', 'base64');

const customerId = 'cust_0123456789abcdef';
const otherCustomerId = 'cust_fedcba9876543210';

function setFixture({
  id,
  customer = customerId,
  version,
  state = 'active',
  references,
}) {
  return {
    schema_version: 'ai-img-gen.customer-identity-set.v1',
    customer_id: customer,
    identity_set_id: id,
    version,
    state,
    display_name: 'fixture',
    coverage: [...new Set(references.map((reference) => reference.role))],
    references,
    created_at: `2026-08-${String(version).padStart(2, '0')}T00:00:00.000Z`,
    updated_at: `2026-08-${String(version).padStart(2, '0')}T00:00:00.000Z`,
  };
}

function referenceFixture({
  ordinal = 1,
  role = 'primary_front',
  sha256 = 'a'.repeat(64),
  width = 640,
  height = 960,
  mimeType = 'image/png',
} = {}) {
  return {
    ordinal,
    role,
    filename: `${String(ordinal).padStart(2, '0')}-${role}.png`,
    original_name: `source-${ordinal}.png`,
    sha256,
    bytes: 1234,
    width,
    height,
    mime_type: mimeType,
    extension: '.png',
  };
}

test('exact repeated identity request reuses the active set without adding a directory or event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'identity-idempotency-'));
  const files = [
    { name: 'front-original.png', bytes: transparentPng, role: 'primary_front' },
    { name: 'left-original.png', bytes: whitePng, role: 'left_45' },
  ];
  const created = await createIdentitySet({ root, customerId, displayName: 'Customer A', files });
  assert.equal(created.idempotent_replay, false);

  const customerDir = join(root, 'data', 'customers', customerId);
  const eventsBefore = await readFile(join(customerDir, 'events.jsonl'), 'utf8');
  const customerBefore = await readFile(join(customerDir, 'customer.json'), 'utf8');
  const directoriesBefore = await readdir(join(customerDir, 'identity-sets'));

  const replayed = await createIdentitySet({
    root,
    customerId,
    displayName: 'A renamed display label does not change identity bytes',
    files: [
      { name: 'renamed-front.png', bytes: transparentPng, role: 'primary_front' },
      { name: 'renamed-left.png', bytes: whitePng, role: 'left_45' },
    ],
  });

  assert.equal(replayed.identity_set_id, created.identity_set_id);
  assert.equal(replayed.version, 1);
  assert.equal(replayed.idempotent_replay, true);
  assert.deepEqual(await readdir(join(customerDir, 'identity-sets')), directoriesBefore);
  assert.equal(await readFile(join(customerDir, 'events.jsonl'), 'utf8'), eventsBefore);
  assert.equal(await readFile(join(customerDir, 'customer.json'), 'utf8'), customerBefore);
});

test('identity idempotency never crosses customer scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'identity-customer-scope-'));
  const files = [{ name: 'front.png', bytes: transparentPng, role: 'primary_front' }];
  const first = await createIdentitySet({ root, customerId, files });
  const second = await createIdentitySet({ root, customerId: otherCustomerId, files });

  assert.notEqual(first.identity_set_id, second.identity_set_id);
  assert.equal(first.version, 1);
  assert.equal(second.version, 1);
  assert.equal(second.idempotent_replay, false);
});

test('identity versions remain monotonic after a set directory is removed and customer counts stay distinct', async () => {
  const root = await mkdtemp(join(tmpdir(), 'identity-monotonic-version-'));
  const first = await createIdentitySet({
    root,
    customerId,
    files: [{ name: 'front-a.png', bytes: transparentPng, role: 'primary_front' }],
  });
  const second = await createIdentitySet({
    root,
    customerId,
    files: [{ name: 'front-b.png', bytes: whitePng, role: 'primary_front' }],
  });
  await rm(join(root, 'data', 'customers', customerId, 'identity-sets', second.identity_set_id), { recursive: true });

  const third = await createIdentitySet({
    root,
    customerId,
    files: [
      { name: 'front-c.png', bytes: transparentPng, role: 'primary_front' },
      { name: 'support-c.png', bytes: whitePng, role: 'identity_support' },
    ],
  });
  const customer = JSON.parse(await readFile(join(root, 'data', 'customers', customerId, 'customer.json'), 'utf8'));

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(third.version, 3);
  assert.equal(customer.identity_set_count, 2);
  assert.equal(customer.latest_identity_set_version, 3);
  assert.equal(customer.active_identity_set_id, third.identity_set_id);
});

test('role, order, or bytes changes are not treated as idempotent repeats', async () => {
  const root = await mkdtemp(join(tmpdir(), 'identity-exactness-'));
  const first = await createIdentitySet({
    root,
    customerId,
    files: [
      { name: 'front.png', bytes: transparentPng, role: 'primary_front' },
      { name: 'support.png', bytes: whitePng, role: 'left_45' },
    ],
  });
  const changedRole = await createIdentitySet({
    root,
    customerId,
    files: [
      { name: 'front.png', bytes: transparentPng, role: 'primary_front' },
      { name: 'support.png', bytes: whitePng, role: 'right_45' },
    ],
  });
  const changedOrder = await createIdentitySet({
    root,
    customerId,
    files: [
      { name: 'support.png', bytes: whitePng, role: 'left_45' },
      { name: 'front.png', bytes: transparentPng, role: 'primary_front' },
    ],
  });

  assert.deepEqual([first.version, changedRole.version, changedOrder.version], [1, 2, 3]);
  assert.equal(changedRole.idempotent_replay, false);
  assert.equal(changedOrder.idempotent_replay, false);
});

test('dedup plan prefers the customer active set and blocks every Run-referenced duplicate', () => {
  assert.equal(typeof governance.buildIdentityDedupPlan, 'function');
  const references = [
    referenceFixture(),
    referenceFixture({ ordinal: 2, role: 'left_45', sha256: 'b'.repeat(64) }),
  ];
  const inactiveId = 'ids_111111111111111111111111';
  const activeId = 'ids_222222222222222222222222';
  const deletableId = 'ids_333333333333333333333333';
  const foreignId = 'ids_444444444444444444444444';
  const inactiveSet = setFixture({ id: inactiveId, version: 9, references });
  const activeSet = setFixture({ id: activeId, version: 11, references });
  const deletableSet = setFixture({ id: deletableId, version: 10, references });
  const foreignSet = setFixture({ id: foreignId, customer: otherCustomerId, version: 12, references });
  const plan = governance.buildIdentityDedupPlan({
    customer: { customer_id: customerId, active_identity_set_id: activeId },
    identitySets: [inactiveSet, activeSet, deletableSet, foreignSet],
    referencedIdentitySetIds: [inactiveId, foreignId],
  });

  assert.equal(plan.canonical_identity_set_id, activeId);
  assert.deepEqual(plan.duplicate_identity_set_ids, [deletableId]);
  assert.deepEqual(plan.blocked, [{ identity_set_id: inactiveId, reason: 'referenced_by_run' }]);
  assert.match(plan.group_hash, /^[a-f0-9]{64}$/);
  assert.equal(plan.recovery_entries.length, 2);
  const blockedRecovery = plan.recovery_entries.find((entry) => entry.identity_set_id === inactiveId);
  const deletionRecovery = plan.recovery_entries.find((entry) => entry.identity_set_id === deletableId);
  assert.equal(blockedRecovery.eligible_for_deletion, false);
  assert.deepEqual(blockedRecovery.blocked_reasons, ['referenced_by_run']);
  assert.equal(deletionRecovery.eligible_for_deletion, true);
  assert.deepEqual(deletionRecovery.identity_set_projection, deletableSet);
  assert.deepEqual(deletionRecovery.references.map(({ sha256, width, height, mime_type }) => ({ sha256, width, height, mime_type })), [
    { sha256: 'a'.repeat(64), width: 640, height: 960, mime_type: 'image/png' },
    { sha256: 'b'.repeat(64), width: 640, height: 960, mime_type: 'image/png' },
  ]);
  assert.equal(plan.inventory.some((group) => group.identity_set_ids.includes(foreignId)), false);
});

test('dedup inventory requires role, order, hash, dimensions, and MIME to all match', () => {
  assert.equal(typeof governance.buildIdentityDedupPlan, 'function');
  const activeId = 'ids_aaaaaaaaaaaaaaaaaaaaaaaa';
  const baseReferences = [
    referenceFixture(),
    referenceFixture({ ordinal: 2, role: 'left_45', sha256: 'b'.repeat(64) }),
  ];
  const variants = [
    [referenceFixture({ role: 'right_45' }), baseReferences[1]],
    [baseReferences[1], baseReferences[0]],
    [referenceFixture({ sha256: 'c'.repeat(64) }), baseReferences[1]],
    [referenceFixture({ width: 641 }), baseReferences[1]],
    [referenceFixture({ height: 961 }), baseReferences[1]],
    [referenceFixture({ mimeType: 'image/jpeg' }), baseReferences[1]],
  ];
  const identitySets = [setFixture({ id: activeId, version: 1, references: baseReferences })];
  for (let index = 0; index < variants.length; index += 1) {
    identitySets.push(setFixture({
      id: `ids_${String(index + 1).repeat(24)}`,
      version: index + 2,
      references: variants[index],
    }));
  }

  const plan = governance.buildIdentityDedupPlan({
    customer: { customer_id: customerId, active_identity_set_id: activeId },
    identitySets,
    referencedIdentitySetIds: [],
  });

  assert.equal(plan.canonical_identity_set_id, null);
  assert.deepEqual(plan.duplicate_identity_set_ids, []);
  assert.deepEqual(plan.blocked, []);
  assert.deepEqual(plan.recovery_entries, []);
  assert.deepEqual(plan.inventory, []);
});
