import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as runStore from '../src/run-store.mjs';

const transparentPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const whitePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlAT8sAAAAASUVORK5CYII=', 'base64');

async function preparedArtifact(root) {
  const run = await runStore.createRunSnapshot({
    root,
    customerName: 'Annotation Customer',
    prompt: 'portrait',
    identityFiles: [{ name: 'identity.png', bytes: transparentPng }],
    templateFiles: [{ name: 'template.png', bytes: whitePng }],
    referencePlan: {
      identityAngles: ['frontal'],
      targetAngle: 'frontal',
      targetFraming: 'half_body',
    },
    customerContext: { intendedUse: 'profile' },
  });
  const imported = await runStore.importArtifacts({
    root,
    runId: run.runId,
    files: [{ name: 'generated.png', bytes: transparentPng }],
  });
  return { runId: run.runId, artifact: imported.manifest.artifacts[0] };
}

function annotationPayload(overrides = {}) {
  return {
    editor_version: 'artifact-annotation-editor-v1',
    fabric_version: '7.4.0',
    canvas: { width: 1, height: 1 },
    overall_note: 'Keep the face, fix the marked hand.',
    state: {
      version: '7.4.0',
      objects: [{ type: 'rect', left: 0, top: 0, width: 1, height: 1 }],
    },
    annotations: [{
      annotation_id: 'mark-1',
      type: 'rectangle',
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      reason_code: 'hand',
      note: 'The fingers look unnatural.',
    }],
    ...overrides,
  };
}

test('annotation save preserves the original and records editable state plus a flattened preview', async () => {
  assert.equal(typeof runStore.saveArtifactAnnotation, 'function');
  assert.equal(typeof runStore.loadArtifactAnnotation, 'function');

  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-annotation-'));
  const { runId, artifact } = await preparedArtifact(root);
  const originalBefore = await readFile(artifact.path);

  const saved = await runStore.saveArtifactAnnotation({
    root,
    runId,
    artifactId: artifact.artifact_id,
    payload: annotationPayload(),
    previewBytes: transparentPng,
  });

  const latest = saved.manifest.artifact_annotations[artifact.artifact_id];
  assert.equal(latest.artifact_id, artifact.artifact_id);
  assert.equal(latest.original_artifact_sha256, artifact.sha256);
  assert.equal(latest.annotation_count, 1);
  assert.equal(latest.canvas.width, 1);
  assert.equal(latest.canvas.height, 1);
  assert.equal(latest.preview_sha256.length, 64);
  assert.equal(latest.state_sha256.length, 64);
  assert.match(latest.state_path, /annotations[\\/].+[\\/]annotation-state\.json$/);
  assert.match(latest.preview_path, /annotations[\\/].+[\\/]annotated-preview\.png$/);
  assert.equal(saved.events.at(-1).type, 'ArtifactAnnotationRecorded');

  const loaded = await runStore.loadArtifactAnnotation({ root, runId, artifactId: artifact.artifact_id });
  assert.equal(loaded.annotation.annotation_session_id, latest.annotation_session_id);
  assert.equal(loaded.state.overall_note, annotationPayload().overall_note);
  assert.equal(loaded.state.annotations[0].note, 'The fingers look unnatural.');
  assert.deepEqual(await readFile(latest.preview_path), transparentPng);
  assert.deepEqual(await readFile(artifact.path), originalBefore);
});

test('all soft mosaic annotations preserve their selected effect variants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-annotation-mosaic-'));
  const { runId, artifact } = await preparedArtifact(root);
  const saved = await runStore.saveArtifactAnnotation({
    root,
    runId,
    artifactId: artifact.artifact_id,
    payload: annotationPayload({
      annotations: ['soft_blur', 'haze', 'frosted'].map((effectVariant, index) => ({
        annotation_id: `mark-mosaic-${index + 1}`,
        type: 'mosaic',
        effect_variant: effectVariant,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        reason_code: 'face',
        note: 'Soften this area.',
      })),
    }),
    previewBytes: transparentPng,
  });

  const loaded = await runStore.loadArtifactAnnotation({ root, runId, artifactId: artifact.artifact_id });
  assert.equal(saved.manifest.artifact_annotations[artifact.artifact_id].annotation_count, 3);
  assert.deepEqual(loaded.state.annotations.map((item) => item.type), ['mosaic', 'mosaic', 'mosaic']);
  assert.deepEqual(loaded.state.annotations.map((item) => item.effect_variant), ['soft_blur', 'haze', 'frosted']);
});

test('annotation revisions keep prior sessions while projecting only the latest session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-annotation-revision-'));
  const { runId, artifact } = await preparedArtifact(root);
  const first = await runStore.saveArtifactAnnotation({
    root,
    runId,
    artifactId: artifact.artifact_id,
    payload: annotationPayload(),
    previewBytes: transparentPng,
  });
  const second = await runStore.saveArtifactAnnotation({
    root,
    runId,
    artifactId: artifact.artifact_id,
    payload: annotationPayload({
      annotations: [
        annotationPayload().annotations[0],
        { annotation_id: 'mark-2', type: 'ellipse', bounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, reason_code: 'hair', note: 'Clean this edge.' },
      ],
    }),
    previewBytes: whitePng,
  });

  const firstProjection = first.manifest.artifact_annotations[artifact.artifact_id];
  const secondProjection = second.manifest.artifact_annotations[artifact.artifact_id];
  assert.notEqual(secondProjection.annotation_session_id, firstProjection.annotation_session_id);
  assert.equal(secondProjection.supersedes_annotation_session_id, firstProjection.annotation_session_id);
  assert.equal(secondProjection.annotation_count, 2);
  assert.equal(second.events.filter((event) => event.type === 'ArtifactAnnotationRecorded').length, 2);
  assert.equal((await readFile(firstProjection.state_path, 'utf8')).length > 0, true);
  assert.equal((await readFile(secondProjection.state_path, 'utf8')).length > 0, true);
});

test('annotation save rejects wrong dimensions, unsafe coordinates, and unknown artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-img-gen-annotation-invalid-'));
  const { runId, artifact } = await preparedArtifact(root);

  await assert.rejects(() => runStore.saveArtifactAnnotation({
    root,
    runId,
    artifactId: artifact.artifact_id,
    payload: annotationPayload({ canvas: { width: 2, height: 1 } }),
    previewBytes: transparentPng,
  }), /dimensions/i);

  await assert.rejects(() => runStore.saveArtifactAnnotation({
    root,
    runId,
    artifactId: artifact.artifact_id,
    payload: annotationPayload({ annotations: [{ ...annotationPayload().annotations[0], bounds: { x: 1.1, y: 0, width: 1, height: 1 } }] }),
    previewBytes: transparentPng,
  }), /normalized bounds/i);

  await assert.rejects(() => runStore.saveArtifactAnnotation({
    root,
    runId,
    artifactId: 'artifact-missing',
    payload: annotationPayload(),
    previewBytes: transparentPng,
  }), /artifact not found/i);
});

test('local service exposes save, restore, preview, and pinned Fabric module routes without GPT submission', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /saveArtifactAnnotation/);
  assert.match(server, /loadArtifactAnnotation/);
  assert.match(server, /resolveAnnotationPreview/);
  assert.match(server, /const annotationRoute/);
  assert.match(server, /annotations.*latest/);
  assert.match(server, /const annotationPreviewRoute/);
  assert.match(server, /vendor\/fabric\.mjs/);
  const annotationStart = server.indexOf('const annotationRoute');
  const annotationEnd = server.indexOf('const artifactRoute', annotationStart);
  const annotationRoutes = server.slice(annotationStart, annotationEnd);
  assert.match(annotationRoutes, /request\.formData\(\)/);
  assert.match(annotationRoutes, /ArtifactAnnotation/);
  assert.doesNotMatch(annotationRoutes, /executor\.|submitRun|stageRun/);
});
