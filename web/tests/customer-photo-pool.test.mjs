import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRunSnapshot } from '../src/run-store.mjs';

const pool = await import('../public/customer-photo-pool.js').catch(() => ({}));
const selection = await import('../src/customer-photo-selection.mjs').catch(() => ({}));
const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function identitySet(referenceCount = 5, { customerId = 'cust_1111111111111111', identitySetId = 'ids_222222222222222222222222' } = {}) {
  return {
    customer_id: customerId,
    identity_set_id: identitySetId,
    version: 3,
    references: Array.from({ length: referenceCount }, (_, index) => ({
      ordinal: index + 1,
      role: index === 1 ? 'primary_front' : 'identity_support',
      original_name: `photo-${index + 1}.png`,
      filename: `${String(index + 1).padStart(2, '0')}.png`,
      sha256: String(index + 1).repeat(64).slice(0, 64),
      width: 800,
      height: 1200,
      mime_type: 'image/png',
    })),
  };
}

test('customer photo pool defaults to primary first, caps at four, and never mutates source references', () => {
  assert.equal(typeof pool.createCustomerPhotoPoolState, 'function');
  assert.equal(typeof pool.toggleCustomerPhotoSelection, 'function');
  assert.equal(typeof pool.setCustomerPhotoPrimary, 'function');
  assert.equal(typeof pool.orderedCustomerPhotoOrdinals, 'function');
  const source = identitySet();
  const before = structuredClone(source);
  const initial = pool.createCustomerPhotoPoolState({ customerId: source.customer_id, identitySet: source, limit: 4 });
  assert.deepEqual(initial.selectedOrdinals, [2, 1, 3, 4]);
  assert.equal(initial.primaryOrdinal, 2);
  assert.deepEqual(pool.orderedCustomerPhotoOrdinals(initial), [2, 1, 3, 4]);
  const capped = pool.toggleCustomerPhotoSelection(initial, 5);
  assert.equal(capped.limitReached, true);
  assert.deepEqual(capped.selectedOrdinals, initial.selectedOrdinals);
  const removedPrimary = pool.toggleCustomerPhotoSelection(initial, 2);
  assert.equal(removedPrimary.primaryOrdinal, 1);
  assert.deepEqual(removedPrimary.selectedOrdinals, [1, 3, 4]);
  const changedPrimary = pool.setCustomerPhotoPrimary(removedPrimary, 4);
  assert.equal(changedPrimary.primaryOrdinal, 4);
  assert.deepEqual(pool.orderedCustomerPhotoOrdinals(changedPrimary), [4, 1, 3]);
  assert.deepEqual(source, before);
});

test('customer or identity-set switch creates a fresh scoped pool without stale ordinals', () => {
  const first = pool.createCustomerPhotoPoolState({ customerId: 'cust_1111111111111111', identitySet: identitySet(3), limit: 4 });
  const secondSet = identitySet(1, { customerId: 'cust_3333333333333333', identitySetId: 'ids_444444444444444444444444' });
  const second = pool.createCustomerPhotoPoolState({ customerId: secondSet.customer_id, identitySet: secondSet, limit: 4 });
  assert.notEqual(first.customerId, second.customerId);
  assert.deepEqual(second.selectedOrdinals, [1]);
  assert.equal(second.primaryOrdinal, 1);
  const empty = pool.createCustomerPhotoPoolState({ customerId: '', identitySet: null, limit: 4 });
  assert.deepEqual(empty.selectedOrdinals, []);
  assert.equal(empty.primaryOrdinal, null);
});

function materializedFixture() {
  const set = identitySet(5);
  const files = set.references.map((reference) => ({
    name: reference.original_name,
    bytes: Buffer.from(reference.original_name),
    role: reference.role,
    sha256: reference.sha256,
  }));
  return { identitySet: set, files };
}

test('server selection materializes only unique selected ordinals with primary first and exact source lineage', () => {
  assert.equal(typeof selection.selectCustomerIdentityFiles, 'function');
  const materialized = materializedFixture();
  const before = {
    identitySet: structuredClone(materialized.identitySet),
    files: materialized.files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })),
  };
  const result = selection.selectCustomerIdentityFiles({
    customerId: materialized.identitySet.customer_id,
    identitySetId: materialized.identitySet.identity_set_id,
    materialized,
    selectedOrdinals: [1, 4, 3],
    primaryOrdinal: 4,
    uploadedFiles: [],
    explicitSelection: true,
  });
  assert.deepEqual(result.selectedOrdinals, [4, 1, 3]);
  assert.equal(result.primaryOrdinal, 4);
  assert.deepEqual(result.files.map((file) => file.name), ['photo-4.png', 'photo-1.png', 'photo-3.png']);
  assert.deepEqual(result.source, {
    customer_id: materialized.identitySet.customer_id,
    identity_set_id: materialized.identitySet.identity_set_id,
    reference_ordinals: [4, 1, 3],
    primary_reference_ordinal: 4,
  });
  assert.deepEqual(materialized, before);
});

test('server selection rejects mixed, duplicate, over-limit, wrong-scope, missing, and invalid-primary requests', () => {
  const materialized = materializedFixture();
  const base = { customerId: materialized.identitySet.customer_id, identitySetId: materialized.identitySet.identity_set_id, materialized, uploadedFiles: [], explicitSelection: true };
  assert.throws(() => selection.selectCustomerIdentityFiles({ ...base, selectedOrdinals: [1, 1], primaryOrdinal: 1 }), /unique/i);
  assert.throws(() => selection.selectCustomerIdentityFiles({ ...base, selectedOrdinals: [1, 2, 3, 4, 5], primaryOrdinal: 1 }), /four/i);
  assert.throws(() => selection.selectCustomerIdentityFiles({ ...base, selectedOrdinals: [1, 3], primaryOrdinal: 2 }), /primary/i);
  assert.throws(() => selection.selectCustomerIdentityFiles({ ...base, selectedOrdinals: [9], primaryOrdinal: 9 }), /reference/i);
  assert.throws(() => selection.selectCustomerIdentityFiles({ ...base, customerId: 'cust_9999999999999999', selectedOrdinals: [1], primaryOrdinal: 1 }), /scope/i);
  assert.throws(() => selection.selectCustomerIdentityFiles({ ...base, selectedOrdinals: [1], primaryOrdinal: 1, uploadedFiles: [{ name: 'mixed.png', bytes: transparentPng }] }), /combine/i);
});

test('Run manifest preserves exact customer photo subset and primary ordinal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-customer-pool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const created = await createRunSnapshot({
    root,
    customerName: 'Pool Customer',
    prompt: 'pool lineage',
    identityFiles: [
      { name: 'primary.png', bytes: transparentPng, role: 'primary_front' },
      { name: 'support.png', bytes: transparentPng, role: 'identity_support' },
    ],
    templateFiles: [{ name: 'template.png', bytes: transparentPng }],
    customerIdentitySource: {
      customer_id: 'cust_1111111111111111',
      identity_set_id: 'ids_222222222222222222222222',
      reference_ordinals: [4, 1],
      primary_reference_ordinal: 4,
    },
  });
  const manifest = JSON.parse(await readFile(created.manifestPath, 'utf8'));
  assert.deepEqual(manifest.customer_identity_source, {
    customer_id: 'cust_1111111111111111',
    identity_set_id: 'ids_222222222222222222222222',
    source_type: 'customer_identity_set',
    reference_ordinals: [4, 1],
    primary_reference_ordinal: 4,
  });
  assert.equal(manifest.identity_references.length, 2);
});

test('homepage and server expose a saved-photo pool without weakening upload fallback', async () => {
  const [html, app, css, server] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="customerPhotoPool"/);
  assert.match(html, /id="customerPhotoPoolGrid"/);
  assert.match(html, /id="customerPhotoPoolSummary"/);
  assert.match(html, /id="identityPreviewGrid"/);
  assert.match(app, /identityReferenceOrdinals/);
  assert.match(app, /primaryIdentityReferenceOrdinal/);
  assert.match(app, /customer-photo-pool\.js/);
  assert.match(app, /customerName:\s*document\.querySelector\('#customerName'\)/);
  assert.match(css, /\.customer-photo-pool/);
  assert.match(server, /selectCustomerIdentityFiles/);
  assert.match(server, /identityReferenceOrdinals/);
  assert.match(server, /primaryIdentityReferenceOrdinal/);
});
