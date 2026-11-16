import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildSubmissionSnapshot, buildGenerationDetails } from '../src/generation-details.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const event = (type, data = {}, time = '2026-09-07T01:00:00Z') => ({ type, data, recorded_at: time });
const base = () => ({ runId: 'run-example', prompt: 'latest edited text', originalPrompt: 'original text', manifest: {
  run_id: 'run-example', image_api: { provider: 'https://images.example/v1', model: 'image-model', operation: 'edit', n: 2, size: '1024x1536', quality: 'high', apiKey: 'SECRET', job_key: 'PRIVATE' },
  identity_references: [{ ordinal: 1, original_name: 'face.png', sha256: 'face-hash', path: 'D:\\private\\face.png' }],
  template_references: [{ ordinal: 1, filename: 'style.png', sha256: 'style-hash' }], artifacts: [{ artifact_id: 'artifact-one' }],
}, events: [] });

test('submission snapshot keeps exact prompt and ordered immutable evidence without credentials or paths', () => {
  const run = base();
  run.manifest.image_api.provider = 'https://user:SECRET@images.example/v1?token=SECRET#PRIVATE';
  const snapshot = buildSubmissionSnapshot(run, { prompt: '  actual prompt\n' });
  assert.equal(snapshot.prompt, '  actual prompt\n');
  assert.equal(snapshot.prompt_sha256, sha('  actual prompt\n'));
  assert.deepEqual(snapshot.references.map(ref => [ref.role, ref.ordinal, ref.sha256]), [['identity', 1, 'face-hash'], ['template', 1, 'style-hash']]);
  assert.equal(snapshot.provider, 'https://images.example/v1');
  assert.equal(snapshot.requested_count, 2);
  assert.equal(snapshot.references[0].url, '/api/runs/run-example/references/identity/0/file');
  assert.equal(snapshot.references[0].name, 'face.png');
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.references[0]), true);
  run.manifest.identity_references[0].sha256 = 'changed';
  assert.equal(snapshot.references[0].sha256, 'face-hash');
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|PRIVATE|D:|apiKey|job_key/);
});

test('explicit transport input order and revision roles override manifest grouping', () => {
  const snapshot = buildSubmissionSnapshot(base(), { prompt: 'edit', orderedReferences: [
    { role: 'style_reference', ordinal: 1, kind: 'template', name: 'style.png', sha256: 'style-hash' },
    { role: 'clean_original', ordinal: 1, kind: 'identity', name: 'original.png', sha256: 'face-hash' },
  ] });
  assert.deepEqual(snapshot.references.map(ref => ref.role), ['style_reference', 'clean_original']);
  assert.equal(snapshot.references[0].url, '/api/runs/run-example/references/template/0/file');
});

test('snapshot never silently substitutes current edited prompt when actual prompt is absent', () => {
  assert.equal(buildSubmissionSnapshot(base()).prompt, null);
  assert.equal(buildSubmissionSnapshot(base()).prompt_sha256, null);
});

test('first attempt snapshot controls historical parameters and prompt after record edits', () => {
  const run = base();
  const first = buildSubmissionSnapshot(run, { prompt: 'first actual prompt', requestedCount: 3 });
  run.events = [event('RunSubmissionAttemptStarted', { request_snapshot: first }), event('RunSubmitted', { elapsed_ms: 1234 }), event('RunRecordUpdated', { prompt_text: 'later edited' }), event('RunSubmissionAttemptStarted', { request_snapshot: buildSubmissionSnapshot(run, { prompt: 'second' }) })];
  run.manifest.image_api.model = 'changed-model';
  const details = buildGenerationDetails(run);
  assert.equal(details.prompt, 'first actual prompt');
  assert.equal(details.model, 'image-model');
  assert.equal(details.requested_count, 3);
  assert.equal(details.returned_count, 1);
  assert.equal(details.elapsed_ms, 1234);
  assert.equal(details.prompt_evidence.status, 'recorded');
  assert.equal(details.prompt_evidence.source, 'request_snapshot');
});

test('later snapshot cannot be attributed to earlier attempt lacking a snapshot', () => {
  const run = base();
  run.events = [event('RunSubmissionAttemptStarted'), event('RunSubmissionAttemptStarted', { request_snapshot: buildSubmissionSnapshot(run, { prompt: 'second actual prompt' }) })];
  assert.notEqual(buildGenerationDetails(run).prompt, 'second actual prompt');
});

test('legacy compilation is reconstructed only when edits occur after sending', () => {
  const run = base();
  run.manifest.prompt_compilation = { compiled_prompt: 'compiled original' };
  run.events = [event('RunSubmissionAttemptStarted'), event('RunSubmitted'), event('RunRecordUpdated', { prompt_text: 'later edit' }, '2026-09-07T02:00:00Z')];
  const details = buildGenerationDetails(run);
  assert.equal(details.prompt, 'compiled original');
  assert.equal(details.prompt_evidence.status, 'reconstructed');
  assert.equal(details.prompt_evidence.source, 'prompt_compilation');
});

test('legacy pre-send edits prevent compilation or original prompt being claimed as actual', () => {
  const run = base();
  run.manifest.prompt_compilation = { compiled_prompt: 'compiled original' };
  run.events = [event('RunRecordUpdated', { prompt_text: 'edited before send' }, '2026-09-07T00:00:00Z'), event('RunSubmissionAttemptStarted'), event('RunSubmitted')];
  const details = buildGenerationDetails(run);
  assert.equal(details.prompt, null);
  assert.equal(details.prompt_evidence.status, 'unknown');
});

test('legacy post-attempt but pre-confirmation edits still conflict with send evidence', () => {
  const run = base();
  run.events = [event('RunSubmissionAttemptStarted', {}, '2026-09-07T00:00:00Z'), event('RunRecordUpdated', { prompt_text: 'racing edit' }, '2026-09-07T00:01:00Z'), event('RunSubmitted')];
  assert.equal(buildGenerationDetails(run).prompt, null);
});

test('legacy original prompt file is available only with a confirmed send and no conflicting edits', () => {
  const run = base();
  run.events = [event('RunSubmitted'), event('RunRecordUpdated', { prompt_text: 'after' }, '2026-09-07T02:00:00Z')];
  assert.equal(buildGenerationDetails(run).prompt, 'original text');
  assert.equal(buildGenerationDetails(run).prompt_evidence.source, 'prompt.txt');
  delete run.originalPrompt;
  assert.equal(buildGenerationDetails(run).prompt, null);
});

test('manual imported legacy records expose unknown generation facts', () => {
  const run = { runId: 'run-old', prompt: 'record note', originalPrompt: 'import note', manifest: { artifacts: [{}] }, events: [event('HistoricalRunImported')] };
  const details = buildGenerationDetails(run);
  for (const key of ['channel', 'model', 'provider', 'operation', 'requested_count', 'size', 'quality', 'elapsed_ms', 'prompt', 'prompt_sha256']) assert.equal(details[key], null, key);
  assert.equal(details.returned_count, 1);
  assert.equal(details.prompt_evidence.status, 'unknown');
});

test('web snapshots have unknown actual model and preserve text-only empty references', () => {
  const run = { runId: 'run-web', manifest: { candidate_slate_request: { requested_count: 2 }, identity_references: [], template_references: [] }, events: [] };
  const snapshot = buildSubmissionSnapshot(run, { prompt: 'draw', channel: 'web' });
  assert.equal(snapshot.channel, 'web');
  assert.equal(snapshot.model, null);
  assert.equal(snapshot.requested_count, 2);
  assert.deepEqual(snapshot.references, []);
});

test('revision snapshots expose semantic input roles and artifact URL without filesystem paths', () => {
  const run = { runId: 'run-revision', manifest: { run_kind: 'artifact_revision', revision_request: { requested_count: 1, input_roles: ['clean_original', 'annotated_location_guidance'] }, revision_source: { parent_run_id: 'run-parent', parent_artifact_id: 'artifact-parent', original_path: 'D:\\secret\\original.png', original_sha256: 'original-hash', annotated_preview_path: 'D:\\secret\\preview.png', annotated_preview_sha256: 'preview-hash' }, artifacts: [] }, events: [] };
  const snapshot = buildSubmissionSnapshot(run, { prompt: 'fix', channel: 'web' });
  assert.deepEqual(snapshot.references.map(ref => ref.role), ['clean_original', 'annotated_location_guidance']);
  assert.equal(snapshot.references[0].url, '/api/runs/run-parent/artifacts/artifact-parent/file');
  assert.doesNotMatch(JSON.stringify(snapshot), /D:|secret/);
  const details = buildGenerationDetails(run);
  assert.equal(details.parent_run_id, 'run-parent');
  assert.equal(details.parent_artifact_id, 'artifact-parent');
});

test('API revision manifest reference roles remain intact with transport file endpoints', () => {
  const run = base();
  run.manifest.identity_references[0].role = 'clean_original';
  assert.equal(buildSubmissionSnapshot(run, { prompt: 'fix' }).references[0].role, 'clean_original');
});

test('stored manifest references use collection index for file URL and preserve original display name', () => {
  const run = base();
  run.manifest.identity_references = [{ filename: '01-face.png', original_filename: 'face.png', sha256: 'face-hash' }, { filename: '02-side.png', sha256: 'side-hash' }];
  run.manifest.template_references = [{ filename: '01-template.png', sha256: 'style-hash' }];
  const snapshot = buildSubmissionSnapshot(run, { prompt: 'draw' });
  assert.deepEqual(snapshot.references.map(ref => ref.url), ['/api/runs/run-example/references/identity/0/file', '/api/runs/run-example/references/identity/1/file', '/api/runs/run-example/references/template/0/file']);
  assert.deepEqual(snapshot.references.map(ref => ref.ordinal), [1, 2, 1]);
  assert.equal(snapshot.references[0].name, 'face.png');
});

test('explicit identity reference ordinal selects the second copy of a duplicate hash', () => {
  const run = base();
  run.manifest.identity_references = [{ filename: 'first.png', sha256: 'duplicate' }, { filename: 'second.png', sha256: 'duplicate' }];
  const snapshot = buildSubmissionSnapshot(run, { prompt: 'draw', orderedReferences: [{ kind: 'identity', role: 'identity_support', ordinal: 2, sha256: 'duplicate' }] });
  assert.equal(snapshot.references[0].url, '/api/runs/run-example/references/identity/1/file');
  assert.equal(snapshot.references[0].name, 'second.png');
});

test('explicit template reference ordinal is resolved inside template collection with duplicate hashes', () => {
  const run = base();
  run.manifest.identity_references = [{ filename: 'face.png', sha256: 'duplicate' }];
  run.manifest.template_references = [{ filename: 'first.png', sha256: 'duplicate' }, { filename: 'second.png', sha256: 'duplicate' }];
  const snapshot = buildSubmissionSnapshot(run, { prompt: 'draw', orderedReferences: [{ role: 'template', ordinal: 2, sha256: 'duplicate' }] });
  assert.equal(snapshot.references[0].url, '/api/runs/run-example/references/template/1/file');
  assert.equal(snapshot.references[0].name, 'second.png');
});

test('ambiguous hash without collection or role position produces unknown reference URL', () => {
  const run = base();
  run.manifest.identity_references = [{ filename: 'first.png', sha256: 'duplicate' }, { filename: 'second.png', sha256: 'duplicate' }];
  const snapshot = buildSubmissionSnapshot(run, { prompt: 'draw', orderedReferences: [{ sha256: 'duplicate' }] });
  assert.equal(snapshot.references[0].url, null);
  assert.equal(snapshot.references[0].name, null);
});

test('legacy v5 web prompt file is only part of the wrapped transport prompt and stays unknown', () => {
  const run = base();
  delete run.manifest.image_api;
  run.manifest.schema_version = 'ai-img-gen.web-run.v5';
  run.events = [event('RunSubmitted')];
  const details = buildGenerationDetails(run);
  assert.equal(details.prompt, null);
  assert.equal(details.prompt_evidence.status, 'unknown');
});

test('legacy web compilation is trusted only for the known v6 and v7 verbatim branches', () => {
  for (const schema of ['ai-img-gen.web-run.v5', 'ai-img-gen.web-run.v6', 'ai-img-gen.web-run.v7', 'ai-img-gen.web-run.v8']) {
    const run = base();
    delete run.manifest.image_api;
    run.manifest.schema_version = schema;
    run.manifest.prompt_compilation = { compiled_prompt: '  compiled transport\n' };
    run.events = [event('RunSubmitted')];
    const details = buildGenerationDetails(run);
    assert.equal(details.prompt, ['ai-img-gen.web-run.v6', 'ai-img-gen.web-run.v7'].includes(schema) ? 'compiled transport' : null, schema);
  }
});

test('legacy v6 web without compilation still wraps the original prompt file', () => {
  const run = base();
  delete run.manifest.image_api;
  run.manifest.schema_version = 'ai-img-gen.web-run.v6';
  run.events = [event('RunSubmitted')];
  assert.equal(buildGenerationDetails(run).prompt, null);
});

test('known legacy artifact revision transport sends original prompt verbatim after trimming', () => {
  const run = base();
  delete run.manifest.image_api;
  run.manifest.schema_version = 'ai-img-gen.artifact-revision-run.v1';
  run.manifest.run_kind = 'artifact_revision';
  run.originalPrompt = '  original revision\n';
  run.events = [event('RunSubmitted')];
  assert.equal(buildGenerationDetails(run).prompt, 'original revision');
  assert.equal(buildGenerationDetails(run).prompt_evidence.source, 'prompt.txt');
  run.manifest.schema_version = 'ai-img-gen.web-run.v5';
  assert.equal(buildGenerationDetails(run).prompt, null);
});
