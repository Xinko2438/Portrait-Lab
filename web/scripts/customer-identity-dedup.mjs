import { createHash } from 'node:crypto';
import { appendFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIdentityDedupPlan } from '../src/customer-identity-governance.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertCustomerId(customerId) {
  if (!/^cust_[a-f0-9]{16}$/.test(String(customerId || ''))) throw new Error('Invalid customer id');
}

function assertInside(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  if (!rel || rel.startsWith('..') || rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`Path is outside the required boundary: ${candidate}`);
  }
}

async function readJson(path) {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
}

async function pathExists(path) {
  try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function fileInventory(root) {
  const out = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        out.push({ relative_path: relative(root, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await visit(root);
  return out;
}

function sameInventory(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function listIdentitySets(root, customerId) {
  const setsRoot = join(root, 'data', 'customers', customerId, 'identity-sets');
  const entries = await readdir(setsRoot, { withFileTypes: true });
  const sets = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^ids_[a-f0-9]{24}$/.test(entry.name)) continue;
    sets.push(await readJson(join(setsRoot, entry.name, 'identity-set.json')));
  }
  return sets;
}

async function referencedIdentitySetIds(root, identitySetIds) {
  const runsRoot = join(root, 'data', 'runs');
  if (!(await pathExists(runsRoot))) return [];
  const ids = new Set(identitySetIds);
  const found = new Set();
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(json|jsonl)$/i.test(entry.name)) {
        const text = await readFile(path, 'utf8');
        for (const id of ids) if (text.includes(id)) found.add(id);
      }
    }
  }
  await visit(runsRoot);
  return [...found].sort();
}

async function verifySetBytes(root, customerId, identitySet) {
  const setRoot = join(root, 'data', 'customers', customerId, 'identity-sets', identitySet.identity_set_id);
  assertInside(join(root, 'data', 'customers', customerId, 'identity-sets'), setRoot);
  for (const reference of identitySet.references || []) {
    const path = join(setRoot, 'references', reference.filename);
    assertInside(setRoot, path);
    const bytes = await readFile(path);
    if (bytes.length !== Number(reference.bytes) || sha256(bytes) !== reference.sha256) {
      throw new Error(`Identity set byte evidence mismatch: ${identitySet.identity_set_id}/${reference.filename}`);
    }
  }
  return fileInventory(setRoot);
}

export async function previewIdentityDedup({ root, customerId, archiveRoot }) {
  assertCustomerId(customerId);
  const resolvedRoot = resolve(root);
  const resolvedArchive = resolve(archiveRoot);
  assertInside(resolvedRoot, resolvedArchive);
  const customerRoot = join(resolvedRoot, 'data', 'customers', customerId);
  const customer = await readJson(join(customerRoot, 'customer.json'));
  const identitySets = await listIdentitySets(resolvedRoot, customerId);
  const referenced = await referencedIdentitySetIds(resolvedRoot, identitySets.map((item) => item.identity_set_id));
  const plan = buildIdentityDedupPlan({ customer, identitySets, referencedIdentitySetIds: referenced });
  for (const identitySet of identitySets) await verifySetBytes(resolvedRoot, customerId, identitySet);
  return { schema_version: 'ai-img-gen.customer-identity-dedup-preview.v1', customer, identitySets, referenced_identity_set_ids: referenced, archive_root: resolvedArchive, plan };
}

export async function applyIdentityDedup({ root, customerId, archiveRoot, expectedGroupHash }) {
  const preview = await previewIdentityDedup({ root, customerId, archiveRoot });
  if (!preview.plan.group_hash || preview.plan.group_hash !== expectedGroupHash) throw new Error('Dedup group hash changed; rerun preview');
  if (preview.plan.blocked.length) throw new Error('Dedup plan is blocked by Run references');
  if (!preview.plan.duplicate_identity_set_ids.length) throw new Error('No duplicate identity sets are eligible for deletion');

  const resolvedRoot = resolve(root);
  const customerRoot = join(resolvedRoot, 'data', 'customers', customerId);
  const setsRoot = join(customerRoot, 'identity-sets');
  const archiveCustomerRoot = join(resolve(archiveRoot), customerId);
  if (await pathExists(archiveCustomerRoot)) throw new Error('Archive destination already exists');
  await mkdir(archiveCustomerRoot, { recursive: true });
  const previousCustomerBytes = await readFile(join(customerRoot, 'customer.json'));
  const previousEventsBytes = await readFile(join(customerRoot, 'events.jsonl')).catch((error) => error.code === 'ENOENT' ? Buffer.alloc(0) : Promise.reject(error));
  await writeFile(join(archiveCustomerRoot, 'customer-before.json'), previousCustomerBytes);
  await writeFile(join(archiveCustomerRoot, 'events-before.jsonl'), previousEventsBytes);

  const entries = [];
  for (const identitySetId of preview.plan.duplicate_identity_set_ids) {
    const sourceDir = join(setsRoot, identitySetId);
    const archiveDir = join(archiveCustomerRoot, 'identity-sets', identitySetId);
    assertInside(setsRoot, sourceDir);
    assertInside(archiveCustomerRoot, archiveDir);
    const sourceInventory = await fileInventory(sourceDir);
    await mkdir(dirname(archiveDir), { recursive: true });
    await cp(sourceDir, archiveDir, { recursive: true, errorOnExist: true, force: false });
    const archiveInventory = await fileInventory(archiveDir);
    if (!sameInventory(sourceInventory, archiveInventory)) throw new Error(`Archive verification failed: ${identitySetId}`);
    entries.push({ identity_set_id: identitySetId, source_dir: sourceDir, archive_dir: archiveDir, files: sourceInventory });
  }

  const archiveManifest = {
    schema_version: 'ai-img-gen.customer-identity-dedup-archive.v1',
    customer_id: customerId,
    canonical_identity_set_id: preview.plan.canonical_identity_set_id,
    group_hash: preview.plan.group_hash,
    previous_customer_sha256: sha256(previousCustomerBytes),
    previous_events_sha256: sha256(previousEventsBytes),
    source_and_archive_hashes_match: true,
    entries,
    created_at: new Date().toISOString(),
  };
  const archiveManifestPath = join(archiveCustomerRoot, 'archive-manifest.json');
  await writeFile(archiveManifestPath, `${JSON.stringify(archiveManifest, null, 2)}\n`);
  const archiveManifestSha256 = sha256(await readFile(archiveManifestPath));

  for (const entry of entries) await rm(entry.source_dir, { recursive: true, force: false });
  const remainingSets = await listIdentitySets(resolvedRoot, customerId);
  const latestVersion = Math.max(...preview.identitySets.map((item) => Number(item.version) || 0));
  const customer = {
    ...preview.customer,
    active_identity_set_id: preview.plan.canonical_identity_set_id,
    identity_set_count: remainingSets.filter((item) => item.state === 'active').length,
    latest_identity_set_version: latestVersion,
    updated_at: new Date().toISOString(),
  };
  await writeFile(join(customerRoot, 'customer.json'), `${JSON.stringify(customer, null, 2)}\n`);
  await appendFile(join(customerRoot, 'events.jsonl'), `${JSON.stringify({
    schema_version: 'ai-img-gen.customer-event.v1',
    event_id: `dedup_${archiveManifestSha256.slice(0, 24)}`,
    type: 'CustomerIdentitySetsDeduplicated',
    customer_id: customerId,
    recorded_at: customer.updated_at,
    data: {
      canonical_identity_set_id: preview.plan.canonical_identity_set_id,
      removed_identity_set_ids: preview.plan.duplicate_identity_set_ids,
      group_hash: preview.plan.group_hash,
      archive_manifest_path: archiveManifestPath,
      archive_manifest_sha256: archiveManifestSha256,
    },
  })}\n`);
  return { status: 'applied', deleted_count: entries.length, archive_manifest_path: archiveManifestPath, archive_manifest_sha256: archiveManifestSha256, customer };
}

export async function restoreIdentityDedup({ root, archiveManifestPath }) {
  const resolvedRoot = resolve(root);
  const manifestPath = resolve(archiveManifestPath);
  assertInside(resolvedRoot, manifestPath);
  const manifest = await readJson(manifestPath);
  assertCustomerId(manifest.customer_id);
  const customerRoot = join(resolvedRoot, 'data', 'customers', manifest.customer_id);
  const setsRoot = join(customerRoot, 'identity-sets');
  let restoredCount = 0;
  for (const entry of manifest.entries || []) {
    const archiveInventory = await fileInventory(entry.archive_dir);
    if (!sameInventory(entry.files, archiveInventory)) throw new Error(`Archived identity evidence changed: ${entry.identity_set_id}`);
    const destination = join(setsRoot, entry.identity_set_id);
    assertInside(setsRoot, destination);
    if (await pathExists(destination)) throw new Error(`Restore destination already exists: ${entry.identity_set_id}`);
    await cp(entry.archive_dir, destination, { recursive: true, errorOnExist: true, force: false });
    const restoredInventory = await fileInventory(destination);
    if (!sameInventory(entry.files, restoredInventory)) throw new Error(`Restored identity evidence mismatch: ${entry.identity_set_id}`);
    restoredCount += 1;
  }
  const archiveCustomerRoot = dirname(manifestPath);
  const customerBytes = await readFile(join(archiveCustomerRoot, 'customer-before.json'));
  if (sha256(customerBytes) !== manifest.previous_customer_sha256) throw new Error('Archived customer projection hash mismatch');
  await writeFile(join(customerRoot, 'customer.json'), customerBytes);
  return { status: 'restored', restored_count: restoredCount, customer_id: manifest.customer_id };
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const options = Object.fromEntries(args.map((value) => value.split('=', 2)));
  const common = { root: options.root, customerId: options.customer, archiveRoot: options.archive };
  const result = mode === 'preview'
    ? await previewIdentityDedup(common)
    : mode === 'apply'
      ? await applyIdentityDedup({ ...common, expectedGroupHash: options.group })
      : mode === 'restore'
        ? await restoreIdentityDedup({ root: options.root, archiveManifestPath: options.manifest })
        : (() => { throw new Error('Mode must be preview, apply, or restore'); })();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
}