import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { inspectImage } from './image-metadata.mjs';

export const MAX_ANNOTATION_STATE_BYTES = 5 * 1024 * 1024;
export const MAX_ANNOTATION_PREVIEW_BYTES = 30 * 1024 * 1024;
export const MAX_ANNOTATION_OBJECTS = 200;

const allowedTypes = new Set(['freehand', 'rectangle', 'ellipse', 'arrow', 'text', 'mosaic']);
const allowedMosaicVariants = new Set(['soft_blur', 'haze', 'frosted']);
const allowedReasons = new Set(['face', 'hair', 'hand', 'clothing', 'pose', 'background', 'lighting', 'text', 'other']);

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function cleanText(value, maxLength, field) {
  const text = String(value || '').trim();
  if (text.length > maxLength) throw new Error(`${field} is too long`);
  return text;
}

function finiteUnit(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function normalizedAnnotation(annotation, index) {
  const annotationId = String(annotation?.annotation_id || '');
  if (!/^mark-[a-zA-Z0-9-]+$/.test(annotationId)) throw new Error(`Invalid annotation id at index ${index}`);
  const type = String(annotation?.type || '');
  if (!allowedTypes.has(type)) throw new Error(`Unsupported annotation type at index ${index}`);
  const reasonCode = String(annotation?.reason_code || 'other');
  if (!allowedReasons.has(reasonCode)) throw new Error(`Unsupported annotation reason at index ${index}`);
  const bounds = annotation?.bounds || {};
  const normalizedBounds = {
    x: Number(bounds.x),
    y: Number(bounds.y),
    width: Number(bounds.width),
    height: Number(bounds.height),
  };
  if (!Object.values(normalizedBounds).every(finiteUnit)
      || normalizedBounds.x + normalizedBounds.width > 1.000001
      || normalizedBounds.y + normalizedBounds.height > 1.000001) {
    throw new Error(`Annotation normalized bounds are outside the image at index ${index}`);
  }
  const effectVariant = type === 'mosaic' ? String(annotation?.effect_variant || '') : '';
  if (type === 'mosaic' && !allowedMosaicVariants.has(effectVariant)) {
    throw new Error(`Unsupported mosaic variant at index ${index}`);
  }
  return {
    annotation_id: annotationId,
    type,
    ...(effectVariant ? { effect_variant: effectVariant } : {}),
    bounds: normalizedBounds,
    reason_code: reasonCode,
    note: cleanText(annotation?.note, 2000, 'Annotation note'),
  };
}

function within(base, candidate) {
  const relativePath = relative(resolve(base), resolve(candidate));
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function annotationArtifactDir(artifact) {
  if (!artifact?.path) throw new Error('Artifact path is unavailable');
  return dirname(resolve(artifact.path));
}

export function validateAnnotationPayload({ artifact, payload, previewBytes }) {
  if (!artifact) throw new Error('Artifact not found');
  const width = Number(payload?.canvas?.width);
  const height = Number(payload?.canvas?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height)
      || width !== Number(artifact.width) || height !== Number(artifact.height)) {
    throw new Error('Annotation canvas dimensions must match the original artifact dimensions');
  }
  if (!payload?.state || typeof payload.state !== 'object' || Array.isArray(payload.state)) {
    throw new Error('Editable annotation state is required');
  }
  const annotations = Array.isArray(payload.annotations) ? payload.annotations : [];
  if (annotations.length > MAX_ANNOTATION_OBJECTS) throw new Error('Too many annotation objects');
  const normalized = annotations.map(normalizedAnnotation);
  if (new Set(normalized.map((item) => item.annotation_id)).size !== normalized.length) {
    throw new Error('Annotation ids must be unique');
  }
  const preview = Buffer.from(previewBytes || []);
  if (!preview.length) throw new Error('Annotated preview PNG is required');
  if (preview.length > MAX_ANNOTATION_PREVIEW_BYTES) throw new Error('Annotated preview exceeds the size limit');
  const previewMetadata = inspectImage(preview);
  if (previewMetadata.mimeType !== 'image/png') throw new Error('Annotated preview must be PNG');
  if (previewMetadata.width !== width || previewMetadata.height !== height) {
    throw new Error('Annotated preview dimensions must match the original artifact dimensions');
  }
  return {
    editorVersion: cleanText(payload.editor_version, 120, 'Editor version') || 'artifact-annotation-editor-v1',
    fabricVersion: cleanText(payload.fabric_version, 40, 'Fabric version'),
    canvas: { width, height },
    overallNote: cleanText(payload.overall_note, 4000, 'Overall note'),
    state: payload.state,
    annotations: normalized,
    preview,
  };
}

export async function writeAnnotationSession({ artifact, payload, previewBytes, previousAnnotation = null, recordedAt = new Date().toISOString() }) {
  const validated = validateAnnotationPayload({ artifact, payload, previewBytes });
  const annotationSessionId = `annotation-${randomUUID()}`;
  const artifactDir = annotationArtifactDir(artifact);
  const sessionDir = join(artifactDir, 'annotations', annotationSessionId);
  const statePath = join(sessionDir, 'annotation-state.json');
  const previewPath = join(sessionDir, 'annotated-preview.png');
  if (!within(artifactDir, statePath) || !within(artifactDir, previewPath)) throw new Error('Annotation path is outside the artifact directory');

  const stateDocument = {
    schema_version: 'ai-img-gen.artifact-annotation-state.v1',
    annotation_session_id: annotationSessionId,
    artifact_id: artifact.artifact_id,
    original_artifact_sha256: artifact.sha256,
    editor_version: validated.editorVersion,
    fabric_version: validated.fabricVersion,
    canvas: validated.canvas,
    overall_note: validated.overallNote,
    state: validated.state,
    annotations: validated.annotations,
    recorded_at: recordedAt,
  };
  const stateBytes = Buffer.from(`${JSON.stringify(stateDocument, null, 2)}\n`, 'utf8');
  if (stateBytes.length > MAX_ANNOTATION_STATE_BYTES) throw new Error('Annotation state exceeds the size limit');

  await mkdir(sessionDir, { recursive: true });
  await writeFile(statePath, stateBytes);
  await writeFile(previewPath, validated.preview);

  return {
    annotation_session_id: annotationSessionId,
    supersedes_annotation_session_id: previousAnnotation?.annotation_session_id || null,
    artifact_id: artifact.artifact_id,
    original_artifact_sha256: artifact.sha256,
    annotation_count: validated.annotations.length,
    reason_codes: [...new Set(validated.annotations.map((item) => item.reason_code))],
    canvas: validated.canvas,
    editor_version: validated.editorVersion,
    fabric_version: validated.fabricVersion,
    state_path: statePath,
    state_sha256: hash(stateBytes),
    preview_path: previewPath,
    preview_sha256: hash(validated.preview),
    preview_bytes: validated.preview.length,
    recorded_at: recordedAt,
  };
}

export async function readAnnotationSession({ artifact, annotation }) {
  if (!annotation) return { annotation: null, state: null };
  const artifactDir = annotationArtifactDir(artifact);
  if (!within(artifactDir, annotation.state_path) || !within(artifactDir, annotation.preview_path)) {
    throw new Error('Annotation path is outside the artifact directory');
  }
  const stateBytes = await readFile(annotation.state_path);
  if (hash(stateBytes) !== annotation.state_sha256) throw new Error('Annotation state hash mismatch');
  return {
    annotation,
    state: JSON.parse(stateBytes.toString('utf8').replace(/^\uFEFF/, '')),
  };
}

export function resolveAnnotationPreview({ artifact, annotation }) {
  if (!annotation) throw new Error('Annotation not found');
  const artifactDir = annotationArtifactDir(artifact);
  if (!within(artifactDir, annotation.preview_path)) throw new Error('Annotation path is outside the artifact directory');
  return resolve(annotation.preview_path);
}
