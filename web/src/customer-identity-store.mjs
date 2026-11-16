import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { inspectImage } from './image-metadata.mjs';
import { identitySetGroupHash } from './customer-identity-governance.mjs';

const CUSTOMER_ID = /^cust_[a-f0-9]{16}$/;
const SET_ID = /^ids_[a-f0-9]{24}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ROLES = new Set(['primary_front', 'left_45', 'right_45', 'profile', 'expression', 'identity_support']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const customerMutations = new Map();

function assertCustomerId(value) { if (!CUSTOMER_ID.test(String(value || ''))) throw new Error('Invalid customer id'); }
function assertSetId(value) { if (!SET_ID.test(String(value || ''))) throw new Error('Invalid identity set id'); }
function clean(value) { return String(value ?? '').trim().replace(/\s+/g, ' '); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function notFound(message = 'Identity set not found') { const error = new Error(message); error.code = 'ENOENT'; return error; }
function stale(message = 'Customer identity set changed; refresh and try again') { const error = new Error(message); error.code = 'ESTALE'; return error; }
function paths(root, customerId) {
  const customerDir = join(root, 'data', 'customers', customerId);
  return { customerDir, customerPath: join(customerDir, 'customer.json'), eventsPath: join(customerDir, 'events.jsonl'), setsDir: join(customerDir, 'identity-sets') };
}
async function readJson(path) { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
async function atomicJson(path, value) { await mkdir(join(path, '..'), { recursive: true }).catch(() => {}); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
async function existingSets(setsDir) { try { return (await readdir(setsDir, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
async function readExistingSetProjections(setsDir, names) {
  const projections = [];
  for (const name of names) {
    if (!SET_ID.test(name)) continue;
    try { projections.push(await readJson(join(setsDir, name, 'identity-set.json'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return projections;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

async function acquireCustomerMutationLock(lockPath, { timeoutMs = 15000, staleMs = 30000 } = {}) {
  await mkdir(dirname(lockPath), { recursive: true });
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
      await handle.close();
      return async () => { await rm(lockPath, { force: true }); };
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > staleMs) {
          let owner = null;
          try { owner = JSON.parse(await readFile(lockPath, 'utf8')); } catch {}
          if (!owner || !processAlive(Number(owner.pid))) {
            await rm(lockPath, { force: true });
            continue;
          }
        }
      } catch (inspectError) {
        if (inspectError?.code !== 'ENOENT') throw inspectError;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
  }
  throw new Error('Customer identity mutation lock timeout');
}

async function withCustomerMutation({ root, customerId }, mutate) {
  assertCustomerId(customerId);
  const lockPath = join(resolve(String(root || '.')), '.runtime', 'customer-identity-locks', `${customerId}.lock`);
  const previous = customerMutations.get(lockPath) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const release = await acquireCustomerMutationLock(lockPath);
    try { return await mutate(); } finally { await release(); }
  });
  customerMutations.set(lockPath, operation);
  try { return await operation; } finally { if (customerMutations.get(lockPath) === operation) customerMutations.delete(lockPath); }
}

async function createIdentitySetUnlocked({ root, customerId, displayName = '', files = [] }) {
  assertCustomerId(customerId);
  if (!files.length) throw new Error('At least one identity file is required');
  const normalized = files.map((file, index) => {
    const bytes = Buffer.from(file.bytes || []);
    if (!bytes.length) throw new Error('Identity file bytes are required');
    const role = String(file.role || (index === 0 ? 'primary_front' : 'identity_support'));
    if (!ROLES.has(role)) throw new Error(`Invalid identity role: ${role}`);
    const metadata = inspectImage(bytes);
    return { source_name: clean(file.name || `identity-${index + 1}${metadata.extension}`), role, bytes, metadata, sha256: sha256(bytes) };
  });
  if (!normalized.some((item) => item.role === 'primary_front')) throw new Error('Identity set requires primary_front');
  const p = paths(root, customerId);
  const setNames = await existingSets(p.setsDir);
  const existingProjections = await readExistingSetProjections(p.setsDir, setNames);
  let previousCustomer = null;
  try { previousCustomer = await readJson(p.customerPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const requestedGroupHash = identitySetGroupHash({
    customerId,
    references: normalized.map((item) => ({
      role: item.role,
      sha256: item.sha256,
      width: item.metadata.width,
      height: item.metadata.height,
      mime_type: item.metadata.mimeType,
    })),
  });
  const idempotentMatches = existingProjections
    .filter((projection) => projection.customer_id === customerId && projection.state === 'active')
    .filter((projection) => identitySetGroupHash({ customerId, references: projection.references }) === requestedGroupHash)
    .sort((a, b) => {
      const aIsActive = a.identity_set_id === previousCustomer?.active_identity_set_id;
      const bIsActive = b.identity_set_id === previousCustomer?.active_identity_set_id;
      if (aIsActive !== bIsActive) return aIsActive ? -1 : 1;
      return Number(b.version || 0) - Number(a.version || 0);
    });
  if (idempotentMatches.length) return { ...idempotentMatches[0], idempotent_replay: true };

  const projectedMaximumVersion = existingProjections.reduce((maximum, projection) => Math.max(maximum, Number(projection.version) || 0), 0);
  const recordedMaximumVersion = previousCustomer && Object.hasOwn(previousCustomer, 'latest_identity_set_version')
    ? Number(previousCustomer.latest_identity_set_version) || 0
    : Number(previousCustomer?.identity_set_count) || 0;
  const version = Math.max(projectedMaximumVersion, recordedMaximumVersion) + 1;
  const identitySetId = `ids_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const setDir = join(p.setsDir, identitySetId);
  const refsDir = join(setDir, 'references');
  await mkdir(refsDir, { recursive: true });
  const references = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const item = normalized[index];
    const filename = `${String(index + 1).padStart(2, '0')}-${item.role}${item.metadata.extension}`;
    await writeFile(join(refsDir, filename), item.bytes);
    references.push({ ordinal: index + 1, role: item.role, filename, original_name: item.source_name, sha256: item.sha256, bytes: item.bytes.length, width: item.metadata.width, height: item.metadata.height, mime_type: item.metadata.mimeType, extension: item.metadata.extension });
  }
  const now = new Date().toISOString();
  const projection = { schema_version: 'ai-img-gen.customer-identity-set.v1', customer_id: customerId, identity_set_id: identitySetId, version, state: 'active', display_name: clean(displayName), coverage: [...new Set(references.map((item) => item.role))], references, created_at: now, updated_at: now };
  await writeFile(join(setDir, 'identity-set.json'), `${JSON.stringify(projection, null, 2)}\n`, 'utf8');
  const activeIdentitySetCount = existingProjections.filter((item) => item.state === 'active').length + 1;
  const customer = { schema_version: 'ai-img-gen.customer.v1', customer_id: customerId, display_name: clean(displayName), active_identity_set_id: identitySetId, identity_set_count: activeIdentitySetCount, latest_identity_set_version: version, created_at: previousCustomer?.created_at || now, updated_at: now };
  await mkdir(p.customerDir, { recursive: true });
  await writeFile(p.customerPath, `${JSON.stringify(customer, null, 2)}\n`, 'utf8');
  await appendFile(p.eventsPath, `${JSON.stringify({ schema_version: 'ai-img-gen.customer-event.v1', event_id: randomUUID(), type: 'CustomerIdentitySetCreated', customer_id: customerId, recorded_at: now, data: { identity_set_id: identitySetId, version, coverage: projection.coverage, reference_hashes: references.map((item) => item.sha256) } })}\n`, 'utf8');
  return { ...projection, idempotent_replay: false };
}

export async function createIdentitySet(options) {
  return withCustomerMutation(options, () => createIdentitySetUnlocked(options));
}

async function appendIdentitySetUnlocked({ root, customerId, identitySetId, files = [] }) {
  assertCustomerId(customerId);
  assertSetId(identitySetId);
  if (!files.length) throw new Error('At least one identity file is required');
  if (files.length > 8) throw new Error('Append accepts at most eight identity files');

  const normalized = files.map((file, index) => {
    const bytes = Buffer.from(file.bytes || []);
    const metadata = inspectImage(bytes);
    return {
      source_name: clean(file.name || `identity-${index + 1}${metadata.extension}`),
      bytes,
      metadata,
      sha256: sha256(bytes),
    };
  });
  const p = paths(root, customerId);
  let customer;
  try { customer = await readJson(p.customerPath); } catch (error) { if (error.code === 'ENOENT') throw notFound(); throw error; }
  if (customer.customer_id !== customerId) throw notFound();
  const parent = await materializeIdentitySet({ root, customerId, identitySetId });
  const parentReferences = parent.identitySet.references || [];
  if (!parentReferences.some((item) => item.role === 'primary_front')) throw new Error('Identity set requires primary_front');

  const seen = new Set(parentReferences.map((item) => String(item.sha256).toLowerCase()));
  const unique = [];
  let duplicateCount = 0;
  for (const item of normalized) {
    if (seen.has(item.sha256)) { duplicateCount += 1; continue; }
    seen.add(item.sha256);
    unique.push(item);
  }
  if (!unique.length) {
    return {
      identity_set: parent.identitySet,
      appended_count: 0,
      duplicate_count: duplicateCount,
      no_changes: true,
      parent_identity_set_id: identitySetId,
    };
  }
  if (parentReferences.length + unique.length > 32) throw new Error('An identity set can contain at most 32 references');

  const setNames = await existingSets(p.setsDir);
  const existingProjections = await readExistingSetProjections(p.setsDir, setNames);
  const desiredGroupHash = identitySetGroupHash({
    customerId,
    references: [
      ...parentReferences,
      ...unique.map((item) => ({ role: 'identity_support', sha256: item.sha256, width: item.metadata.width, height: item.metadata.height, mime_type: item.metadata.mimeType })),
    ],
  });
  const replay = existingProjections.find((projection) => projection.customer_id === customerId
    && projection.parent_identity_set_id === identitySetId
    && projection.change_type === 'append'
    && identitySetGroupHash({ customerId, references: projection.references }) === desiredGroupHash);
  if (replay) {
    return {
      identity_set: replay,
      appended_count: 0,
      duplicate_count: normalized.length,
      no_changes: true,
      parent_identity_set_id: identitySetId,
    };
  }

  const projectedMaximumVersion = existingProjections.reduce((maximum, projection) => Math.max(maximum, Number(projection.version) || 0), 0);
  const recordedMaximumVersion = Object.hasOwn(customer, 'latest_identity_set_version')
    ? Number(customer.latest_identity_set_version) || 0
    : Number(customer.identity_set_count) || 0;
  const version = Math.max(projectedMaximumVersion, recordedMaximumVersion) + 1;
  const successorId = `ids_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const setDir = join(p.setsDir, successorId);
  const refsDir = join(setDir, 'references');
  await mkdir(refsDir, { recursive: true });

  for (let index = 0; index < parentReferences.length; index += 1) {
    await writeFile(join(refsDir, parentReferences[index].filename), parent.files[index].bytes);
  }
  const references = parentReferences.map((item) => ({ ...item }));
  for (const item of unique) {
    const ordinal = references.length + 1;
    const filename = `${String(ordinal).padStart(2, '0')}-identity_support${item.metadata.extension}`;
    await writeFile(join(refsDir, filename), item.bytes);
    references.push({
      ordinal,
      role: 'identity_support',
      filename,
      original_name: item.source_name,
      sha256: item.sha256,
      bytes: item.bytes.length,
      width: item.metadata.width,
      height: item.metadata.height,
      mime_type: item.metadata.mimeType,
      extension: item.metadata.extension,
    });
  }

  const now = new Date().toISOString();
  const projection = {
    schema_version: 'ai-img-gen.customer-identity-set.v1',
    customer_id: customerId,
    identity_set_id: successorId,
    version,
    state: 'active',
    display_name: parent.identitySet.display_name,
    coverage: [...new Set(references.map((item) => item.role))],
    references,
    parent_identity_set_id: identitySetId,
    change_type: 'append',
    created_at: now,
    updated_at: now,
  };
  await writeFile(join(setDir, 'identity-set.json'), `${JSON.stringify(projection, null, 2)}\n`, 'utf8');
  const activeIdentitySetCount = existingProjections.filter((item) => item.state === 'active').length + 1;
  const nextCustomer = {
    ...customer,
    active_identity_set_id: successorId,
    identity_set_count: activeIdentitySetCount,
    latest_identity_set_version: version,
    updated_at: now,
  };
  await writeFile(p.customerPath, `${JSON.stringify(nextCustomer, null, 2)}\n`, 'utf8');
  await appendFile(p.eventsPath, `${JSON.stringify({
    schema_version: 'ai-img-gen.customer-event.v1',
    event_id: randomUUID(),
    type: 'CustomerIdentitySetCreated',
    customer_id: customerId,
    recorded_at: now,
    data: {
      identity_set_id: successorId,
      version,
      coverage: projection.coverage,
      reference_hashes: references.map((item) => item.sha256),
      parent_identity_set_id: identitySetId,
      change_type: 'append',
      appended_reference_hashes: unique.map((item) => item.sha256),
      duplicate_count: duplicateCount,
    },
  })}\n`, 'utf8');
  return {
    identity_set: projection,
    appended_count: unique.length,
    duplicate_count: duplicateCount,
    no_changes: false,
    parent_identity_set_id: identitySetId,
  };
}

export async function appendIdentitySet(options) {
  return withCustomerMutation(options, () => appendIdentitySetUnlocked(options));
}

function normalizedPhotoName(name, reference) {
  const value = clean(name).normalize('NFC');
  if (!value) throw new Error('Photo name is required');
  if (/[<>:"/\\|?*\u0000-\u001f]/u.test(value)) throw new Error('Photo name contains reserved path characters');
  const suppliedExtension = extname(value).toLowerCase();
  const base = (IMAGE_EXTENSIONS.has(suppliedExtension) ? value.slice(0, -suppliedExtension.length) : value).trim();
  if (!base || base === '.' || base === '..') throw new Error('Photo name is required');
  if (base.length > 100) throw new Error('Photo name cannot exceed 100 characters');
  const realExtension = String(reference.extension || extname(reference.filename || '') || extname(reference.original_name || '')).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(realExtension)) throw new Error('Identity reference image extension is invalid');
  return `${base}${realExtension}`;
}

function assertReferenceMutationInput({ referenceOrdinal, expectedReferenceSha256, expectedActiveIdentitySetId }) {
  const parsedOrdinal = Number(referenceOrdinal);
  if (!Number.isInteger(parsedOrdinal) || parsedOrdinal <= 0) throw new Error('Invalid identity reference ordinal');
  if (!SHA256.test(String(expectedReferenceSha256 || ''))) throw new Error('Invalid expected identity reference hash');
  assertSetId(expectedActiveIdentitySetId);
  return parsedOrdinal;
}

function mutationReplay(projections, { identitySetId, changeType, reference, nextOriginalName = null }) {
  return projections.find((projection) => projection.parent_identity_set_id === identitySetId
    && projection.change_type === changeType
    && projection.change?.source_ordinal === Number(reference.ordinal)
    && projection.change?.reference_sha256 === reference.sha256
    && (changeType !== 'rename_reference' || projection.change?.new_original_name === nextOriginalName));
}

function mutationResult({ projection, identitySetId, changeType, reference, nextOriginalName = null, idempotentReplay = false, noChanges = false }) {
  return {
    identity_set: projection,
    parent_identity_set_id: identitySetId,
    change_type: changeType,
    target: {
      ordinal: Number(reference.ordinal),
      sha256: reference.sha256,
      previous_original_name: reference.original_name || reference.filename,
      ...(nextOriginalName ? { new_original_name: nextOriginalName } : {}),
    },
    idempotent_replay: idempotentReplay,
    no_changes: noChanges,
  };
}

async function mutateIdentityReferenceUnlocked({
  root,
  customerId,
  identitySetId,
  referenceOrdinal,
  expectedReferenceSha256,
  expectedActiveIdentitySetId,
  changeType,
  name = '',
}) {
  assertCustomerId(customerId);
  assertSetId(identitySetId);
  const targetOrdinal = assertReferenceMutationInput({ referenceOrdinal, expectedReferenceSha256, expectedActiveIdentitySetId });
  if (!['rename_reference', 'remove_reference'].includes(changeType)) throw new Error('Invalid identity reference change type');

  const p = paths(root, customerId);
  let customer;
  try { customer = await readJson(p.customerPath); } catch (error) { if (error.code === 'ENOENT') throw notFound(); throw error; }
  if (customer.customer_id !== customerId) throw notFound();
  const parent = await materializeIdentitySet({ root, customerId, identitySetId });
  const parentReferences = parent.identitySet.references || [];
  const reference = parentReferences.find((item) => Number(item.ordinal) === targetOrdinal);
  if (!reference) throw notFound('Identity reference not found');
  if (reference.sha256 !== expectedReferenceSha256) throw stale('Identity reference changed; refresh and try again');
  const nextOriginalName = changeType === 'rename_reference' ? normalizedPhotoName(name, reference) : null;
  if (changeType === 'remove_reference' && parentReferences.length <= 1) throw new Error('An identity set must retain at least one photo');

  const setNames = await existingSets(p.setsDir);
  const existingProjections = await readExistingSetProjections(p.setsDir, setNames);
  const replay = mutationReplay(existingProjections, { identitySetId, changeType, reference, nextOriginalName });
  if (customer.active_identity_set_id !== expectedActiveIdentitySetId) {
    if (replay && customer.active_identity_set_id === replay.identity_set_id) {
      return mutationResult({ projection: replay, identitySetId, changeType, reference, nextOriginalName, idempotentReplay: true });
    }
    throw stale();
  }
  if (replay) {
    if (customer.active_identity_set_id !== replay.identity_set_id) throw stale();
    return mutationResult({ projection: replay, identitySetId, changeType, reference, nextOriginalName, idempotentReplay: true });
  }
  if (changeType === 'rename_reference' && nextOriginalName === (reference.original_name || reference.filename)) {
    return mutationResult({ projection: parent.identitySet, identitySetId, changeType, reference, nextOriginalName, idempotentReplay: true, noChanges: true });
  }

  let references;
  if (changeType === 'rename_reference') {
    references = parentReferences.map((item) => Number(item.ordinal) === targetOrdinal ? { ...item, original_name: nextOriginalName } : { ...item });
  } else {
    references = parentReferences.filter((item) => Number(item.ordinal) !== targetOrdinal).map((item) => ({ ...item }));
    if (reference.role === 'primary_front') {
      const promotedOrdinal = Math.min(...references.map((item) => Number(item.ordinal)));
      references = references.map((item) => Number(item.ordinal) === promotedOrdinal ? { ...item, role: 'primary_front' } : item);
    }
  }

  const projectedMaximumVersion = existingProjections.reduce((maximum, projection) => Math.max(maximum, Number(projection.version) || 0), 0);
  const recordedMaximumVersion = Object.hasOwn(customer, 'latest_identity_set_version')
    ? Number(customer.latest_identity_set_version) || 0
    : Number(customer.identity_set_count) || 0;
  const version = Math.max(projectedMaximumVersion, recordedMaximumVersion) + 1;
  const successorId = `ids_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const setDir = join(p.setsDir, successorId);
  const refsDir = join(setDir, 'references');
  await mkdir(refsDir, { recursive: true });
  const parentFileByOrdinal = new Map(parentReferences.map((item, index) => [Number(item.ordinal), parent.files[index]]));
  for (const item of references) {
    const file = parentFileByOrdinal.get(Number(item.ordinal));
    if (!file || file.sha256 !== item.sha256) throw new Error('Identity reference materialization mismatch');
    await writeFile(join(refsDir, item.filename), file.bytes);
  }

  const now = new Date().toISOString();
  const targetReference = {
    source_ordinal: targetOrdinal,
    reference_sha256: reference.sha256,
    previous_original_name: reference.original_name || reference.filename,
    ...(nextOriginalName ? { new_original_name: nextOriginalName } : {}),
  };
  const projection = {
    schema_version: 'ai-img-gen.customer-identity-set.v1',
    customer_id: customerId,
    identity_set_id: successorId,
    version,
    state: 'active',
    display_name: parent.identitySet.display_name,
    coverage: [...new Set(references.map((item) => item.role))],
    references,
    parent_identity_set_id: identitySetId,
    change_type: changeType,
    change: targetReference,
    created_at: now,
    updated_at: now,
  };
  await writeFile(join(setDir, 'identity-set.json'), `${JSON.stringify(projection, null, 2)}\n`, 'utf8');
  const activeIdentitySetCount = existingProjections.filter((item) => item.state === 'active').length + 1;
  await writeFile(p.customerPath, `${JSON.stringify({
    ...customer,
    active_identity_set_id: successorId,
    identity_set_count: activeIdentitySetCount,
    latest_identity_set_version: version,
    updated_at: now,
  }, null, 2)}\n`, 'utf8');
  await appendFile(p.eventsPath, `${JSON.stringify({
    schema_version: 'ai-img-gen.customer-event.v1',
    event_id: randomUUID(),
    type: 'CustomerIdentitySetCreated',
    customer_id: customerId,
    recorded_at: now,
    data: {
      identity_set_id: successorId,
      version,
      coverage: projection.coverage,
      reference_hashes: references.map((item) => item.sha256),
      parent_identity_set_id: identitySetId,
      change_type: changeType,
      target_reference: targetReference,
      resulting_reference_hashes: references.map((item) => item.sha256),
    },
  })}\n`, 'utf8');
  return mutationResult({ projection, identitySetId, changeType, reference, nextOriginalName });
}

export async function renameIdentityReference(options) {
  return withCustomerMutation(options, () => mutateIdentityReferenceUnlocked({ ...options, changeType: 'rename_reference' }));
}

export async function removeIdentityReference(options) {
  return withCustomerMutation(options, () => mutateIdentityReferenceUnlocked({ ...options, changeType: 'remove_reference' }));
}

export async function listCustomers({ root }) {
  const base = join(root, 'data', 'customers');
  let entries; try { entries = await readdir(base, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !CUSTOMER_ID.test(entry.name)) continue;
    try { out.push(await readJson(join(base, entry.name, 'customer.json'))); } catch {}
  }
  return out.sort((a, b) => String(a.display_name).localeCompare(String(b.display_name), 'zh-CN'));
}

export async function listIdentitySets({ root, customerId }) {
  assertCustomerId(customerId);
  const p = paths(root, customerId);
  const names = await existingSets(p.setsDir);
  const out = [];
  for (const name of names) { if (!SET_ID.test(name)) continue; try { out.push(await readJson(join(p.setsDir, name, 'identity-set.json'))); } catch {} }
  return out.sort((a, b) => Number(b.version) - Number(a.version));
}

export async function materializeIdentitySet({ root, customerId, identitySetId }) {
  assertCustomerId(customerId); assertSetId(identitySetId);
  const p = paths(root, customerId);
  let projection;
  try { projection = await readJson(join(p.setsDir, identitySetId, 'identity-set.json')); } catch (error) { if (error.code === 'ENOENT') throw notFound(); throw error; }
  if (projection.customer_id !== customerId || projection.identity_set_id !== identitySetId) throw notFound();
  const files = [];
  for (const reference of projection.references || []) {
    const path = join(p.setsDir, identitySetId, 'references', reference.filename);
    const bytes = await readFile(path);
    if (sha256(bytes) !== reference.sha256) throw new Error('Identity reference hash mismatch');
    files.push({ name: reference.original_name || reference.filename, bytes, role: reference.role, sha256: reference.sha256 });
  }
  return { identitySet: projection, files };
}
