import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import {
  FACE_TAG_VOCABULARY,
  loadIdentityFaceTagProjections,
  loadTemplateFaceTagProgress,
  loadTemplateFaceTagProjection,
  loadTemplateFaceTagStatuses,
  matchIdentityFaceTags,
  recordIdentityFaceTag,
  recordTemplateFaceTag,
} from './face-tag-store.mjs';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const IMAGE_TYPES = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']]);

function json(res, status, value) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(value));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('JSON request body is too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON request body must be an object');
  return value;
}

function statusFor(error) {
  const message = String(error?.message || error);
  if (/not found/i.test(message)) return 404;
  if (/hash mismatch|supersedes/i.test(message)) return 409;
  return 400;
}

function publicError(error) {
  return { error: { message: String(error?.message || error) } };
}

async function readIdentitySet(root, customerId, identitySetId) {
  const path = join(root, 'data', 'customers', customerId, 'identity-sets', identitySetId, 'identity-set.json');
  let value;
  try {
    value = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('Identity set not found');
    throw error;
  }
  if (value.customer_id !== customerId || value.identity_set_id !== identitySetId || !Array.isArray(value.references)) throw new Error('Identity set not found');
  return value;
}

async function resolveIdentityReference({ root, customerId, identitySetId, ordinal }) {
  const set = await readIdentitySet(root, customerId, identitySetId);
  const reference = set.references.find((item) => Number(item.ordinal) === Number(ordinal));
  if (!reference || basename(String(reference.filename || '')) !== reference.filename) throw new Error('Identity reference not found');
  const path = join(root, 'data', 'customers', customerId, 'identity-sets', identitySetId, 'references', reference.filename);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('Identity reference not found');
    throw error;
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== reference.sha256) throw new Error('Identity reference hash mismatch');
  return { reference, bytes, mimeType: reference.mime_type || IMAGE_TYPES.get(extname(reference.filename).toLowerCase()) || 'application/octet-stream' };
}

function recordArgs(body) {
  return {
    kind: body.kind,
    imageSha256: body.image_sha256,
    idempotencyKey: body.idempotency_key,
    actor: body.actor,
    tag: body.tag,
    modelVersion: body.model_version,
    promptVersion: body.prompt_version,
    supersedesEventId: body.supersedes_event_id,
  };
}

export function createFaceTagApiHandler({ root }) {
  if (!root) throw new TypeError('root is required');
  return async function handleFaceTagRequest(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const templateRoute = url.pathname.match(/^\/api\/templates\/(tpl_temp_aiimg_[a-z0-9_-]+)\/face-tag$/);
    const identityListRoute = url.pathname.match(/^\/api\/customers\/(cust_[a-f0-9]{16})\/identity-sets\/(ids_[a-f0-9]{24})\/face-tags$/);
    const identityTagRoute = url.pathname.match(/^\/api\/customers\/(cust_[a-f0-9]{16})\/identity-sets\/(ids_[a-f0-9]{24})\/references\/(\d+)\/face-tag$/);
    const identityFileRoute = url.pathname.match(/^\/api\/customers\/(cust_[a-f0-9]{16})\/identity-sets\/(ids_[a-f0-9]{24})\/references\/(\d+)\/file$/);
    const isVocabulary = url.pathname === '/api/face-tags/vocabulary';
    const isProgress = url.pathname === '/api/face-tags/templates/progress';
    const isStatuses = url.pathname === '/api/face-tags/templates/statuses';
    const isMatch = url.pathname === '/api/face-tags/match';
    if (!templateRoute && !identityListRoute && !identityTagRoute && !identityFileRoute && !isVocabulary && !isProgress && !isStatuses && !isMatch) return false;
    try {
      if (req.method === 'GET' && isVocabulary) {
        json(res, 200, { vocabulary: FACE_TAG_VOCABULARY });
        return true;
      }
      if (req.method === 'GET' && isProgress) {
        json(res, 200, { progress: await loadTemplateFaceTagProgress({ root }) });
        return true;
      }
      if (req.method === 'GET' && isStatuses) {
        json(res, 200, { statuses: await loadTemplateFaceTagStatuses({ root }) });
        return true;
      }
      if (templateRoute && req.method === 'GET') {
        json(res, 200, { projection: await loadTemplateFaceTagProjection({ root, templateUid: templateRoute[1] }) });
        return true;
      }
      if (templateRoute && req.method === 'POST') {
        const result = await recordTemplateFaceTag({ root, templateUid: templateRoute[1], ...recordArgs(await readJsonBody(req)) });
        json(res, result.idempotent_replay ? 200 : 201, result);
        return true;
      }
      if (identityListRoute && req.method === 'GET') {
        json(res, 200, { projection: await loadIdentityFaceTagProjections({ root, customerId: identityListRoute[1], identitySetId: identityListRoute[2] }) });
        return true;
      }
      if (identityTagRoute && req.method === 'POST') {
        const result = await recordIdentityFaceTag({
          root,
          customerId: identityTagRoute[1],
          identitySetId: identityTagRoute[2],
          ordinal: Number(identityTagRoute[3]),
          ...recordArgs(await readJsonBody(req)),
        });
        json(res, result.idempotent_replay ? 200 : 201, result);
        return true;
      }
      if (identityFileRoute && req.method === 'GET') {
        const resolved = await resolveIdentityReference({ root, customerId: identityFileRoute[1], identitySetId: identityFileRoute[2], ordinal: Number(identityFileRoute[3]) });
        res.writeHead(200, { 'content-type': resolved.mimeType, 'cache-control': 'no-store' });
        res.end(resolved.bytes);
        return true;
      }
      if (isMatch && req.method === 'POST') {
        const body = await readJsonBody(req);
        const [templateProjection, identityProjection, identitySetValue] = await Promise.all([
          loadTemplateFaceTagProjection({ root, templateUid: body.template_uid }),
          loadIdentityFaceTagProjections({ root, customerId: body.customer_id, identitySetId: body.identity_set_id }),
          readIdentitySet(root, body.customer_id, body.identity_set_id),
        ]);
        const identityReferences = identitySetValue.references.map((reference) => ({
          ordinal: Number(reference.ordinal),
          image_sha256: reference.sha256,
          projection: identityProjection.references[String(Number(reference.ordinal))],
        }));
        json(res, 200, { result: matchIdentityFaceTags({ templateProjection, identityReferences }) });
        return true;
      }
      json(res, 405, { error: { message: 'Method not allowed' } });
      return true;
    } catch (error) {
      json(res, statusFor(error), publicError(error));
      return true;
    }
  };
}
