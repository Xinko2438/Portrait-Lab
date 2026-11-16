import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const serviceModule = await import('../src/intelligent-workbench/compounding-service.mjs').catch(() => ({}));

test('compounding service exposes outcome bridging, metrics rebuild, and correction recording', () => {
  assert.equal(typeof serviceModule.createCompoundingService, 'function');
  const calls = [];
  const service = serviceModule.createCompoundingService({
    loadRun: async () => ({ manifest: {}, events: [] }),
    listRuns: async () => [],
    recordRunEvent: async (input) => { calls.push(input); return input; },
    recordOutcome: async () => ({ idempotent_replay: false }),
  });
  assert.equal(typeof service.bridgeRunOutcome, 'function');
  assert.equal(typeof service.rebuildMetrics, 'function');
  assert.equal(typeof service.recordReviewSuggestion, 'function');
  assert.equal(typeof service.recordHumanCorrection, 'function');
});

test('server integrates metrics, outcome bridge, duplicate preview, and disabled suggestion routes', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /createCompoundingService/);
  assert.match(server, /\/api\/compounding\/metrics/);
  assert.match(server, /bridgeRunOutcome/);
  const artifactReviewRoute = server.slice(
    server.indexOf('const artifactRoute'),
    server.indexOf('const importRoute'),
  );
  assert.match(artifactReviewRoute, /compounding\.bridgeRunOutcome\(\{ runId \}\)/);
  assert.match(server, /identityDuplicatesRoute/);
  assert.match(server, /buildIdentityDedupPlan/);
  assert.match(server, /review-suggestion/);
  assert.match(server, /disabled_pending_contract/);
});

test('compounding bridge loads active selection Outcomes and executes invalidation-only reconciliation', async () => {
  const invalidationCalls = [];
  const activeOutcomes = [{
    selection_id: 'sel_active',
    outcome_id: 'out_active',
    run_id: 'run-active',
    artifact_id: 'artifact-active',
  }];
  const service = serviceModule.createCompoundingService({
    root: 'fixture-root',
    loadRun: async () => ({
      manifest: {
        run_id: 'run-active',
        template_selection: { selection_id: 'sel_active' },
      },
      events: [],
    }),
    listRuns: async () => [],
    loadSelection: async () => ({ active_outcomes: activeOutcomes }),
    recordRunEvent: async ({ data }) => ({ manifest: { template_outcome_bridge: data } }),
    recordOutcome: async () => { throw new Error('recordOutcome should not run'); },
    invalidateOutcome: async (command) => { invalidationCalls.push(command); return { idempotent_replay: false }; },
    deriveBridge: async ({ activeOutcomes: loaded, invalidateOutcome }) => {
      assert.deepEqual(loaded, activeOutcomes);
      await invalidateOutcome({ selectionId: 'sel_active', outcomeId: 'out_active' });
      return {
        status: 'deferred',
        reason: 'final_preference_pending',
        commands: [],
        invalidations: [{ selectionId: 'sel_active', outcomeId: 'out_active' }],
        recorded: 0,
        idempotent: 0,
        invalidated: 1,
        invalidation_idempotent: 0,
        deferred: 1,
        results: [],
      };
    },
  });
  const result = await service.bridgeRunOutcome({ runId: 'run-active' });
  assert.equal(result.invalidated, 1);
  assert.deepEqual(invalidationCalls, [{ selectionId: 'sel_active', outcomeId: 'out_active' }]);
});

test('compounding bridge propagates selection truth corruption instead of reconciling with an empty Outcome set', async () => {
  let deriveCalled = false;
  const service = serviceModule.createCompoundingService({
    root: 'fixture-root',
    loadRun: async () => ({ manifest: { run_id: 'run-corrupt', template_selection: { selection_id: 'sel_corrupt' } }, events: [] }),
    listRuns: async () => [],
    loadSelection: async () => { const error = new Error('selection projection corrupt'); error.code = 'selection_event_conflict'; throw error; },
    recordRunEvent: async (input) => input,
    recordOutcome: async () => ({}),
    invalidateOutcome: async () => ({}),
    deriveBridge: async () => { deriveCalled = true; return { status: 'deferred', reason: 'should_not_run', commands: [], invalidations: [] }; },
  });
  await assert.rejects(() => service.bridgeRunOutcome({ runId: 'run-corrupt' }), /selection projection corrupt/);
  assert.equal(deriveCalled, false);
});

test('metrics rebuild propagates selection corruption instead of silently reporting zero Outcomes', async () => {
  const service = serviceModule.createCompoundingService({
    root: 'fixture-root',
    listRuns: async () => [{ run_id: 'run-corrupt-metrics' }],
    loadRun: async () => ({
      manifest: { run_id: 'run-corrupt-metrics', template_selection: { selection_id: 'sel_corrupt_metrics' } },
      events: [],
    }),
    loadSelection: async () => {
      const error = new Error('selection projection corrupt during metrics');
      error.code = 'selection_event_conflict';
      throw error;
    },
    recordRunEvent: async (input) => input,
  });

  await assert.rejects(() => service.rebuildMetrics(), /selection projection corrupt during metrics/);
});

test('metrics rebuild consumes only active Outcome truth, never invalidated history', async () => {
  let captured = null;
  const active = { outcome_id: 'out_active', run_id: 'run-active-metrics', artifact_id: 'artifact-active', scores: {} };
  const invalidated = { outcome_id: 'out_invalidated', run_id: 'run-active-metrics', artifact_id: 'artifact-active', scores: {} };
  const service = serviceModule.createCompoundingService({
    root: 'fixture-root',
    listRuns: async () => [{ run_id: 'run-active-metrics' }],
    loadRun: async () => ({ manifest: { run_id: 'run-active-metrics', template_selection: { selection_id: 'sel_active_metrics' } }, events: [] }),
    loadSelection: async () => ({ outcomes: [invalidated, active], active_outcomes: [active] }),
    recordRunEvent: async (input) => input,
    buildMetrics: (input) => { captured = input; return input; },
  });

  await service.rebuildMetrics();
  assert.deepEqual(captured.outcomes, [active]);
});

test('invalidation-only Outcome history contributes zero metrics support', async () => {
  let captured = null;
  const invalidated = { outcome_id: 'out_invalidated_only', run_id: 'run-invalidated-only', artifact_id: 'artifact-invalidated', scores: {} };
  const service = serviceModule.createCompoundingService({
    root: 'fixture-root',
    listRuns: async () => [{ run_id: 'run-invalidated-only' }],
    loadRun: async () => ({ manifest: { run_id: 'run-invalidated-only', template_selection: { selection_id: 'sel_invalidated_only' } }, events: [] }),
    loadSelection: async () => ({ outcomes: [invalidated], active_outcomes: [] }),
    recordRunEvent: async (input) => input,
    buildMetrics: (input) => { captured = input; return input; },
  });

  await service.rebuildMetrics();
  assert.deepEqual(captured.outcomes, []);
});

test('server exposes reviewer calibration as a read-only status and metrics keep it separate', async () => {
  const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /loadReviewerCalibrationProjection/);
  assert.match(server, /req\.method === 'GET' && url\.pathname === '\/api\/reviewer-calibration\/status'/);
  assert.doesNotMatch(server, /req\.method === 'POST' && url\.pathname === '\/api\/reviewer-calibration/);

  const calibration = {
    schema_version: 'ai-img-gen.reviewer-calibration-projection.v1',
    status: 'not_configured',
    active_anchor_set: null,
    latest_session: null,
    median_absolute_deviation: null,
    valid_until: null,
  };
  const service = serviceModule.createCompoundingService({
    root: 'unused',
    loadRun: async () => ({ manifest: {}, events: [] }),
    listRuns: async () => [],
    recordRunEvent: async (input) => input,
    loadReviewerCalibration: async () => calibration,
  });
  const metrics = await service.rebuildMetrics();
  assert.deepEqual(metrics.reviewer_calibration, calibration);
});

test('run projection keeps AI suggestion, human correction, and outcome bridge evidence separate', async () => {
  const store = await readFile(new URL('../src/run-store.mjs', import.meta.url), 'utf8');
  assert.match(store, /ReviewSuggestionRecorded/);
  assert.match(store, /HumanCorrectionRecorded/);
  assert.match(store, /TemplateOutcomeBridgeProcessed/);
  assert.match(store, /review_suggestions/);
  assert.match(store, /human_corrections/);
  assert.match(store, /template_outcome_bridge/);
});

test('workbench shows compounding metrics and AI suggestion status without replacing human review', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="compoundingSummary"/);
  assert.match(html, /id="aiSuggestionPanel"/);
  assert.match(app, /\/api\/compounding\/metrics/);
  assert.match(app, /AI 建议/);
  assert.match(app, /人工评审/);
});
test('v6 Run wiring preserves reusable customer identity source provenance', async () => {
  const [server, store] = await Promise.all([
    readFile(new URL('../src/server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/run-store.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(server, /customerIdentitySource/);
  assert.match(store, /customer_identity_source/);
  assert.match(store, /identity_set_id/);
});
test('bridge Run evidence is idempotent even when the outcome recorder reports replay statistics', async () => {
  let manifest = {};
  let bridgeCall = 0;
  const runEvents = [];
  const service = serviceModule.createCompoundingService({
    loadRun: async () => ({ manifest, events: [] }),
    listRuns: async () => [],
    recordRunEvent: async (input) => {
      runEvents.push(input);
      manifest = { ...manifest, template_outcome_bridge: { status: 'processed', ...input.data } };
      return { manifest };
    },
    recordOutcome: async () => ({}),
    deriveBridge: async () => ({ status: 'ready', reason: null, commands: [{ selectionId: 'sel_x', outcomeIdempotencyKey: 'key_x' }], recorded: bridgeCall++ === 0 ? 1 : 0, idempotent: bridgeCall > 1 ? 1 : 0, deferred: 0, results: [] }),
  });
  const first = await service.bridgeRunOutcome({ runId: 'run-x' });
  const second = await service.bridgeRunOutcome({ runId: 'run-x' });
  assert.equal(first.run_event_idempotent, false);
  assert.equal(second.run_event_idempotent, true);
  assert.equal(runEvents.length, 1);
});
