import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHistoryWorkspaceState,
  deriveHistoryRunState,
  filterAndSortHistoryRuns,
  historyCustomerKey,
  historyCustomerOptions,
  transitionHistoryWorkspace,
} from '../public/history-workspace.js';

function run(overrides = {}) {
  return {
    run_id: 'run-default',
    created_at: '2026-08-20T08:00:00.000Z',
    updated_at: '2026-08-20T08:00:00.000Z',
    customer_id: 'customer-default',
    customer_name: 'Default Customer',
    artifact_count: 1,
    reviewed_count: 1,
    preference: { decision: 'winner' },
    batch_label: 'Default Batch',
    intended_use: 'Profile portrait',
    prompt: 'Default prompt',
    ...overrides,
  };
}

test('createHistoryWorkspaceState supplies defaults and rejects an incomplete detail view', () => {
  assert.deepEqual(createHistoryWorkspaceState(), {
    view: 'list',
    query: '',
    customerKey: '',
    status: 'all',
    sort: 'newest',
    detailRunId: null,
  });

  assert.deepEqual(createHistoryWorkspaceState({
    view: 'detail',
    query: null,
    customerKey: 42,
    status: 'unknown',
    sort: 'sideways',
    detailRunId: '   ',
  }), {
    view: 'list',
    query: '',
    customerKey: '',
    status: 'all',
    sort: 'newest',
    detailRunId: null,
  });

  assert.deepEqual(createHistoryWorkspaceState({ view: 'detail', detailRunId: '  run-7  ' }), {
    view: 'detail',
    query: '',
    customerKey: '',
    status: 'all',
    sort: 'newest',
    detailRunId: 'run-7',
  });
});

test('filter transitions normalize values and survive import, detail, and back navigation', () => {
  let state = createHistoryWorkspaceState();
  state = transitionHistoryWorkspace(state, { type: 'SET_QUERY', value: '  Summer Hero  ' });
  state = transitionHistoryWorkspace(state, { type: 'SET_CUSTOMER', value: '  customer-7  ' });
  state = transitionHistoryWorkspace(state, { type: 'SET_STATUS', value: 'pending_choice' });
  state = transitionHistoryWorkspace(state, { type: 'SET_SORT', value: 'oldest' });

  const filters = {
    query: 'Summer Hero',
    customerKey: 'customer-7',
    status: 'pending_choice',
    sort: 'oldest',
  };
  assert.deepEqual(state, { view: 'list', ...filters, detailRunId: null });

  state = transitionHistoryWorkspace(state, { type: 'OPEN_IMPORT' });
  assert.deepEqual(state, { view: 'import', ...filters, detailRunId: null });

  state = transitionHistoryWorkspace(state, { type: 'BACK_TO_LIST' });
  state = transitionHistoryWorkspace(state, { type: 'OPEN_DETAIL', runId: '  run-detail  ' });
  assert.deepEqual(state, { view: 'detail', ...filters, detailRunId: 'run-detail' });

  assert.deepEqual(transitionHistoryWorkspace(state, { type: 'BACK_TO_LIST' }), {
    view: 'list',
    ...filters,
    detailRunId: null,
  });
});

test('RESET_FILTERS clears list controls without changing the current view', () => {
  const state = createHistoryWorkspaceState({
    view: 'import',
    query: 'portrait',
    customerKey: 'customer-2',
    status: 'pending_review',
    sort: 'oldest',
  });

  assert.deepEqual(transitionHistoryWorkspace(state, { type: 'RESET_FILTERS' }), {
    view: 'import',
    query: '',
    customerKey: '',
    status: 'all',
    sort: 'newest',
    detailRunId: null,
  });
});

test('invalid transition values fall back safely and detail never opens without a run id', () => {
  let state = createHistoryWorkspaceState({ view: 'import', status: 'completed', sort: 'oldest' });
  state = transitionHistoryWorkspace(state, { type: 'SET_STATUS', value: 'invalid' });
  state = transitionHistoryWorkspace(state, { type: 'SET_SORT', value: 'invalid' });
  state = transitionHistoryWorkspace(state, { type: 'SET_QUERY', value: null });
  state = transitionHistoryWorkspace(state, { type: 'SET_CUSTOMER', value: {} });
  state = transitionHistoryWorkspace(state, { type: 'OPEN_DETAIL', runId: '   ' });

  assert.deepEqual(state, createHistoryWorkspaceState());
  assert.deepEqual(transitionHistoryWorkspace(state, { type: 'UNKNOWN' }), state);
});

test('deriveHistoryRunState separates unfinished review, unfinished choice, and completion', () => {
  assert.equal(deriveHistoryRunState(run({ artifact_count: 3, reviewed_count: 2 })), 'pending_review');
  assert.equal(deriveHistoryRunState(run({ preference: { decision: 'pending' } })), 'pending_choice');
  assert.equal(deriveHistoryRunState(run({ preference: null, latest_preference: { decision: 'winner' } })), 'completed');
  assert.equal(deriveHistoryRunState(run({ preference: { decision: 'none' } })), 'completed');
  assert.equal(deriveHistoryRunState(run({ preference: undefined, latest_preference: undefined, status: 'completed' })), 'completed');
});

test('historyCustomerKey prefers customer_id and falls back to a normalized legacy name', () => {
  assert.equal(historyCustomerKey({ customer_id: 'customer-42', customer_name: 'Ignored Name' }), 'customer-42');
  assert.equal(historyCustomerKey({ customer_id: '   ', customer_name: '  Legacy CUSTOMER  ' }), 'legacy customer');
  assert.equal(historyCustomerKey({ customer_name: '   ' }), '');
});

test('historyCustomerOptions deduplicates keys and sorts labels stably without changing runs', () => {
  const runs = [
    run({ run_id: 'run-b', customer_id: 'customer-b', customer_name: '  Beta  ' }),
    run({ run_id: 'run-a1', customer_id: '', customer_name: 'Alpha' }),
    run({ run_id: 'run-a2', customer_id: '', customer_name: ' alpha ' }),
    run({ run_id: 'run-c', customer_id: 'customer-c', customer_name: 'Charlie' }),
    run({ run_id: 'run-empty', customer_id: '', customer_name: '  ' }),
  ];
  const before = structuredClone(runs);

  assert.deepEqual(historyCustomerOptions(runs), [
    { key: 'alpha', label: 'Alpha' },
    { key: 'customer-b', label: 'Beta' },
    { key: 'customer-c', label: 'Charlie' },
  ]);
  assert.deepEqual(runs, before);
});

test('query matches customer, batch, intended use, use case, and prompt case-insensitively', () => {
  const cases = [
    ['customer_name', run({ run_id: 'run-customer', customer_name: '  ALICE ZHANG  ' }), ' alice '],
    ['batch_label', run({ run_id: 'run-batch', batch_label: '', history_import: { batch_label: 'Summer Launch' } }), ' launch '],
    ['intended_use', run({ run_id: 'run-use', intended_use: 'Executive PROFILE' }), ' profile '],
    ['use_case', run({ run_id: 'run-case', intended_use: '', use_case: 'Book Jacket' }), ' jacket '],
    ['prompt', run({ run_id: 'run-prompt', prompt: 'Soft CINEMATIC lighting' }), ' cinematic '],
  ];

  for (const [field, candidate, query] of cases) {
    const result = filterAndSortHistoryRuns([candidate], createHistoryWorkspaceState({ query }));
    assert.deepEqual(result.map((item) => item.run_id), [candidate.run_id], field);
  }
});

test('query, customer, and derived status filters combine and can produce an empty result', () => {
  const runs = [
    run({
      run_id: 'run-target',
      customer_id: 'customer-a',
      customer_name: 'Alice',
      batch_label: 'Summer portraits',
      artifact_count: 2,
      reviewed_count: 2,
      preference: null,
    }),
    run({
      run_id: 'run-wrong-state',
      customer_id: 'customer-a',
      customer_name: 'Alice',
      batch_label: 'Summer portraits',
      preference: { decision: 'winner' },
    }),
    run({
      run_id: 'run-wrong-customer',
      customer_id: 'customer-b',
      customer_name: 'Bob',
      batch_label: 'Summer portraits',
      artifact_count: 2,
      reviewed_count: 2,
      preference: null,
    }),
  ];

  const state = createHistoryWorkspaceState({
    query: '  SUMMER  ',
    customerKey: 'customer-a',
    status: 'pending_choice',
  });
  assert.deepEqual(filterAndSortHistoryRuns(runs, state).map((item) => item.run_id), ['run-target']);
  assert.deepEqual(filterAndSortHistoryRuns(runs, { ...state, query: 'winter' }), []);
});

test('status filtering uses review progress before final-choice state', () => {
  const runs = [
    run({ run_id: 'run-review', artifact_count: 2, reviewed_count: 1, preference: { decision: 'winner' } }),
    run({ run_id: 'run-choice', artifact_count: 2, reviewed_count: 2, preference: null }),
    run({ run_id: 'run-complete', artifact_count: 2, reviewed_count: 2, preference: { decision: 'none' } }),
  ];

  assert.deepEqual(filterAndSortHistoryRuns(runs, { status: 'pending_review' }).map((item) => item.run_id), ['run-review']);
  assert.deepEqual(filterAndSortHistoryRuns(runs, { status: 'pending_choice' }).map((item) => item.run_id), ['run-choice']);
  assert.deepEqual(filterAndSortHistoryRuns(runs, { status: 'completed' }).map((item) => item.run_id), ['run-complete']);
});

test('sorting uses updated_at with created_at fallback and run_id as a deterministic tie-breaker', () => {
  const runs = [
    run({ run_id: 'run-b', created_at: '2026-08-10T00:00:00Z', updated_at: '2026-08-22T00:00:00Z' }),
    run({ run_id: 'run-a', created_at: '2026-08-20T00:00:00Z', updated_at: '2026-08-22T00:00:00Z' }),
    run({ run_id: 'run-c', created_at: '2026-08-21T00:00:00Z', updated_at: '' }),
  ];

  assert.deepEqual(filterAndSortHistoryRuns(runs, { sort: 'newest' }).map((item) => item.run_id), [
    'run-a',
    'run-b',
    'run-c',
  ]);
  assert.deepEqual(filterAndSortHistoryRuns(runs, { sort: 'oldest' }).map((item) => item.run_id), [
    'run-c',
    'run-a',
    'run-b',
  ]);
});

test('filterAndSortHistoryRuns leaves both the run array and state untouched', () => {
  const runs = [
    run({ run_id: 'run-2', updated_at: '2026-08-22T00:00:00Z' }),
    run({ run_id: 'run-1', updated_at: '2026-08-21T00:00:00Z' }),
  ];
  const state = createHistoryWorkspaceState({ query: 'default', sort: 'oldest' });
  const runsBefore = structuredClone(runs);
  const stateBefore = structuredClone(state);

  const result = filterAndSortHistoryRuns(runs, state);

  assert.notEqual(result, runs);
  assert.deepEqual(runs, runsBefore);
  assert.deepEqual(state, stateBefore);
});
