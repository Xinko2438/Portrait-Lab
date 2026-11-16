import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveRunReferenceFile } from '../src/reference-files.mjs';

const runDir = join('D:', 'workspace', 'data', 'runs', 'run-test');

function runWithReferences() {
  return {
    runDir,
    manifest: {
      identity_references: [{ path: join(runDir, 'identity', '01.jpg'), filename: 'identity.jpg' }],
      template_references: [{ path: join(runDir, 'templates', '01.png'), filename: 'template.png' }],
    },
  };
}

test('reference files resolve only from the requested run-scoped collection', () => {
  const identity = resolveRunReferenceFile({ run: runWithReferences(), kind: 'identity', index: '0' });
  const template = resolveRunReferenceFile({ run: runWithReferences(), kind: 'template', index: '0' });
  assert.equal(identity.path, join(runDir, 'identity', '01.jpg'));
  assert.equal(template.path, join(runDir, 'templates', '01.png'));
  assert.equal(identity.filename, 'identity.jpg');
  assert.equal(template.filename, 'template.png');
});

test('reference files reject invalid kinds, indexes, and paths outside the run', () => {
  const run = runWithReferences();
  assert.throws(() => resolveRunReferenceFile({ run, kind: 'other', index: '0' }), /kind/i);
  assert.throws(() => resolveRunReferenceFile({ run, kind: 'identity', index: '2' }), /not found/i);
  assert.throws(() => resolveRunReferenceFile({ run, kind: 'identity', index: '-1' }), /index/i);
  run.manifest.identity_references[0].path = join('D:', 'workspace', 'outside.jpg');
  assert.throws(() => resolveRunReferenceFile({ run, kind: 'identity', index: '0' }), /outside/i);
});
