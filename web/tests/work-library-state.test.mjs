import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWorkLibrary,
  deriveWorkLibraryMetrics,
  isWorkLibraryPending,
  workLibraryCustomerKey,
} from '../public/work-library-state.js';

function artifact(id, overrides = {}) {
  return {
    artifact_id: id,
    reviewed: true,
    preference_eligible: true,
    is_winner: false,
    comparison_state: 'eligible',
    ...overrides,
  };
}

function run(id, overrides = {}) {
  return {
    run_id: id,
    run_kind: 'generation',
    created_at: '2026-08-20T08:00:00.000Z',
    updated_at: '2026-08-20T08:00:00.000Z',
    customer_id: 'cust-default',
    customer_name: 'Default Customer',
    status: 'completed',
    artifact_count: 1,
    reviewed_count: 1,
    preference: { decision: 'winner', winner_artifact_id: `${id}-artifact-1` },
    artifacts: [artifact(`${id}-artifact-1`, { is_winner: true })],
    template_learning: { state: 'not_applicable', active_outcome_count: 0 },
    ...overrides,
  };
}

function rootRuns(library) {
  return library.groups.flatMap((group) => group.runs);
}

test('pending view includes unreviewed work and reviewed work awaiting a final preference', () => {
  const runs = [
    run('run-unreviewed', {
      artifact_count: 2,
      reviewed_count: 1,
      artifacts: [artifact('artifact-u1'), artifact('artifact-u2', { reviewed: false })],
    }),
    run('run-pending-choice', {
      preference: { decision: 'pending', winner_artifact_id: null },
      artifacts: [artifact('artifact-p1')],
    }),
    run('run-winner'),
    run('run-none', { preference: { decision: 'none', winner_artifact_id: null } }),
  ];

  assert.equal(isWorkLibraryPending(runs[0]), true);
  assert.equal(isWorkLibraryPending(runs[1]), true);
  assert.equal(isWorkLibraryPending(runs[2]), false);
  assert.equal(isWorkLibraryPending(runs[3]), false);
  assert.deepEqual(rootRuns(buildWorkLibrary(runs, { view: 'pending' })).map((item) => item.run_id), [
    'run-pending-choice',
    'run-unreviewed',
  ]);
});

test('final view returns only the current winner Artifact from explicitly finalized winner Runs', () => {
  const runs = [
    run('run-winner', {
      preference: { decision: 'winner', winner_artifact_id: 'artifact-win' },
      artifact_count: 2,
      reviewed_count: 2,
      artifacts: [
        artifact('artifact-win', { is_winner: false }),
        artifact('artifact-alt'),
      ],
    }),
    run('run-none', {
      preference: { decision: 'none', winner_artifact_id: null },
      artifacts: [artifact('artifact-rejected')],
    }),
    run('run-pending', {
      preference: { decision: 'pending', winner_artifact_id: null },
      artifacts: [artifact('artifact-pending', { is_winner: true })],
    }),
  ];

  const entries = rootRuns(buildWorkLibrary(runs, { view: 'final' }));
  assert.deepEqual(entries.map((item) => item.run_id), ['run-winner']);
  assert.deepEqual(entries[0].artifacts.map((item) => item.artifact_id), ['artifact-win']);
});

test('current preference winner ID overrides stale Artifact winner flags in final and qualified views', () => {
  const runs = [run('run-current-winner', {
    preference: { decision: 'winner', winner_artifact_id: 'artifact-current' },
    artifact_count: 2,
    reviewed_count: 2,
    artifacts: [
      artifact('artifact-current', { is_winner: false }),
      artifact('artifact-stale', { is_winner: true }),
    ],
  })];

  const finalEntries = rootRuns(buildWorkLibrary(runs, { view: 'final' }));
  const qualifiedEntries = rootRuns(buildWorkLibrary(runs, { view: 'qualified' }));

  assert.deepEqual(finalEntries[0].artifacts.map((item) => item.artifact_id), ['artifact-current']);
  assert.deepEqual(qualifiedEntries[0].artifacts.map((item) => item.artifact_id), ['artifact-stale']);
});

test('qualified view returns only gate-qualified non-winners and excludes every all-rejected Run', () => {
  const runs = [
    run('run-winner', {
      preference: { decision: 'winner', winner_artifact_id: 'artifact-win' },
      artifact_count: 3,
      reviewed_count: 3,
      artifacts: [
        artifact('artifact-win', { is_winner: true }),
        artifact('artifact-qualified-alt'),
        artifact('artifact-failed', { preference_eligible: false, comparison_state: 'not_eligible' }),
      ],
    }),
    run('run-pending', {
      preference: { decision: 'pending', winner_artifact_id: null },
      artifacts: [artifact('artifact-qualified-pending')],
    }),
    run('run-none', {
      preference: { decision: 'none', winner_artifact_id: null },
      artifacts: [artifact('artifact-qualified-but-rejected')],
    }),
  ];

  const entries = rootRuns(buildWorkLibrary(runs, { view: 'qualified' }));
  assert.deepEqual(entries.map((item) => item.run_id), ['run-pending', 'run-winner']);
  assert.deepEqual(entries.map((item) => item.artifacts.map((candidate) => candidate.artifact_id)), [
    ['artifact-qualified-pending'],
    ['artifact-qualified-alt'],
  ]);
});

test('explicit preference_eligible boolean overrides legacy gate fields when classifying qualified work', () => {
  const runs = [run('run-qualification-precedence', {
    preference: { decision: 'pending', winner_artifact_id: null },
    artifact_count: 3,
    reviewed_count: 3,
    artifacts: [
      artifact('artifact-explicitly-rejected', {
        preference_eligible: false,
        gate_qualified: true,
        gate_state: 'qualified',
      }),
      artifact('artifact-explicitly-qualified', {
        preference_eligible: true,
        gate_qualified: false,
        gate_state: 'needs_revision',
      }),
      {
        artifact_id: 'artifact-legacy-qualified',
        reviewed: true,
        gate_qualified: true,
        comparison_state: 'eligible',
      },
    ],
  })];

  const entries = rootRuns(buildWorkLibrary(runs, { view: 'qualified' }));
  assert.deepEqual(entries[0].artifacts.map((item) => item.artifact_id), [
    'artifact-explicitly-qualified',
    'artifact-legacy-qualified',
  ]);
});

test('all view keeps every visible Run and every Artifact without reclassifying final state', () => {
  const runs = [
    run('run-winner'),
    run('run-none', { preference: { decision: 'none', winner_artifact_id: null } }),
    run('run-empty', { artifact_count: 0, reviewed_count: 0, preference: null, artifacts: [] }),
  ];

  const entries = rootRuns(buildWorkLibrary(runs, { view: 'all' }));
  assert.deepEqual(entries.map((item) => item.run_id), ['run-empty', 'run-none', 'run-winner']);
  assert.deepEqual(entries.map((item) => item.artifacts.length), [0, 1, 1]);
});

test('customer grouping prefers opaque IDs, keeps equal display names separate, and normalizes legacy fallback names', () => {
  const runs = [
    run('run-beta', { customer_id: 'cust-b', customer_name: 'Beta' }),
    run('run-alpha-2', { customer_id: 'cust-2', customer_name: 'Alpha' }),
    run('run-alpha-1', { customer_id: 'cust-1', customer_name: 'Alpha' }),
    run('run-legacy-1', { customer_id: '', customer_name: '  Legacy Person  ' }),
    run('run-legacy-2', { customer_id: '', customer_name: 'legacy person' }),
  ];

  assert.equal(workLibraryCustomerKey(runs[0]), 'cust-b');
  assert.equal(workLibraryCustomerKey(runs[3]), 'legacy:legacy person');
  assert.deepEqual(buildWorkLibrary(runs, { view: 'all' }).groups.map((group) => ({
    key: group.customerKey,
    label: group.customerLabel,
    runs: group.runs.map((item) => item.run_id),
  })), [
    { key: 'cust-1', label: 'Alpha', runs: ['run-alpha-1'] },
    { key: 'cust-2', label: 'Alpha', runs: ['run-alpha-2'] },
    { key: 'cust-b', label: 'Beta', runs: ['run-beta'] },
    { key: 'legacy:legacy person', label: 'Legacy Person', runs: ['run-legacy-1', 'run-legacy-2'] },
  ]);
});

test('customer grouping falls back to nested identity and display fields and namespaces legacy names', () => {
  const nested = run('run-nested', {
    customer_id: '',
    customer_name: '',
    customer_identity_source: { customer_id: 'cust-nested' },
    customer_scope: { customer_name: 'Nested Person' },
  });
  const opaque = run('run-opaque', { customer_id: 'alice', customer_name: 'Opaque Alice' });
  const legacy = run('run-legacy-collision', { customer_id: '', customer_name: 'Alice' });

  assert.equal(workLibraryCustomerKey(nested), 'cust-nested');
  assert.equal(workLibraryCustomerKey(opaque), 'alice');
  assert.equal(workLibraryCustomerKey(legacy), 'legacy:alice');

  const groups = buildWorkLibrary([nested, opaque, legacy], { view: 'all' }).groups;
  assert.equal(groups.find((group) => group.customerKey === 'cust-nested')?.customerLabel, 'Nested Person');
  assert.deepEqual(new Set(groups.map((group) => group.customerKey)), new Set([
    'cust-nested',
    'alice',
    'legacy:alice',
  ]));
});

test('artifact revision Runs are nested under their immutable parent and labelled as revisions', () => {
  const runs = [
    run('run-parent', { updated_at: '2026-08-20T08:00:00.000Z' }),
    run('run-child', {
      run_kind: 'artifact_revision',
      parent_run_id: 'run-parent',
      parent_artifact_id: 'run-parent-artifact-1',
      updated_at: '2026-08-22T08:00:00.000Z',
    }),
  ];

  const entries = rootRuns(buildWorkLibrary(runs, { view: 'all' }));
  assert.deepEqual(entries.map((item) => item.run_id), ['run-parent']);
  assert.deepEqual(entries[0].children.map((item) => item.run_id), ['run-child']);
  assert.equal(entries[0].children[0].relationLabel, '修改版');
  assert.equal(entries[0].children[0].relationState, 'nested_revision');
  assert.equal(entries[0].children[0].parent_artifact_id, 'run-parent-artifact-1');
});

test('artifact revisions nest only under a parent with the same nonempty opaque customer identity', () => {
  const runs = [
    run('run-parent', { customer_id: 'cust-a', customer_name: 'Customer A' }),
    run('run-valid-revision', {
      run_kind: 'artifact_revision',
      parent_run_id: 'run-parent',
      customer_id: 'cust-a',
      customer_name: 'Customer A',
    }),
    run('run-mismatch-revision', {
      run_kind: 'artifact_revision',
      parent_run_id: 'run-parent',
      customer_id: 'cust-b',
      customer_name: 'Customer B',
    }),
    run('run-legacy-revision', {
      run_kind: 'artifact_revision',
      parent_run_id: 'run-parent',
      customer_id: '',
      customer_name: 'Customer A',
    }),
  ];

  const roots = rootRuns(buildWorkLibrary(runs, { view: 'all' }));
  const parent = roots.find((item) => item.run_id === 'run-parent');
  const mismatch = roots.find((item) => item.run_id === 'run-mismatch-revision');
  const legacy = roots.find((item) => item.run_id === 'run-legacy-revision');

  assert.deepEqual(parent.children.map((item) => item.run_id), ['run-valid-revision']);
  assert.equal(parent.children[0].relationState, 'nested_revision');
  assert.equal(mismatch.relationState, 'invalid_customer_mismatch');
  assert.equal(legacy.relationState, 'invalid_customer_identity');
  assert.deepEqual(mismatch.children, []);
  assert.deepEqual(legacy.children, []);
});

test('conflicting strong customer IDs inside one Run invalidate identity and prevent nesting or group merging', () => {
  const runs = [
    run('run-parent', {
      customer_id: 'cust-a',
      customer_identity_source: { customer_id: 'cust-a' },
      customer_scope: { customer_id: 'cust-a' },
    }),
    run('run-conflicted-revision', {
      run_kind: 'artifact_revision',
      parent_run_id: 'run-parent',
      customer_id: 'cust-a',
      customer_identity_source: { customer_id: 'cust-b' },
      customer_scope: { customer_id: 'cust-a' },
    }),
    run('run-consistent-peer', {
      customer_id: 'cust-a',
      customer_identity_source: { customer_id: 'cust-a' },
    }),
  ];

  assert.equal(workLibraryCustomerKey(runs[1]), 'invalid-customer:run-conflicted-revision');

  const library = buildWorkLibrary(runs, { view: 'all' });
  const roots = rootRuns(library);
  const parent = roots.find((item) => item.run_id === 'run-parent');
  const conflicted = roots.find((item) => item.run_id === 'run-conflicted-revision');

  assert.deepEqual(parent.children, []);
  assert.equal(conflicted.customerIdentityState, 'invalid_internal_conflict');
  assert.equal(conflicted.relationState, 'invalid_customer_identity');
  assert.notEqual(
    library.groups.find((group) => group.runs.some((item) => item.run_id === 'run-conflicted-revision')).customerKey,
    library.groups.find((group) => group.runs.some((item) => item.run_id === 'run-consistent-peer')).customerKey,
  );
});

test('parent cycles remain visible as isolated invalid roots instead of disappearing from the library', () => {
  const runs = [
    run('run-cycle-a', {
      run_kind: 'artifact_revision',
      parent_run_id: 'run-cycle-b',
      customer_id: 'cust-cycle',
    }),
    run('run-cycle-b', {
      run_kind: 'artifact_revision',
      parent_run_id: 'run-cycle-a',
      customer_id: 'cust-cycle',
    }),
  ];

  const library = buildWorkLibrary(runs, { view: 'all' });
  const roots = rootRuns(library);

  assert.deepEqual(roots.map((item) => item.run_id), ['run-cycle-a', 'run-cycle-b']);
  assert.deepEqual(roots.map((item) => item.relationState), [
    'invalid_parent_cycle',
    'invalid_parent_cycle',
  ]);
  assert.deepEqual(roots.map((item) => item.children), [[], []]);
  assert.equal(library.runCount, 2);
  assert.equal(library.artifactCount, 2);
});

test('ordinary generation Runs remain roots even if legacy data contains a parent_run_id', () => {
  const runs = [
    run('run-parent', { updated_at: '2026-08-20T08:00:00.000Z' }),
    run('run-generation-child', {
      run_kind: 'generation',
      parent_run_id: 'run-parent',
      updated_at: '2026-08-22T08:00:00.000Z',
    }),
  ];

  const entries = rootRuns(buildWorkLibrary(runs, { view: 'all' }));
  assert.deepEqual(entries.map((item) => item.run_id), ['run-generation-child', 'run-parent']);
  assert.deepEqual(entries.map((item) => item.children), [[], []]);
});

test('sorting is deterministic for groups, root Runs, and revision children and never mutates inputs', () => {
  const runs = [
    run('run-z', { customer_id: 'cust-z', customer_name: 'Zulu', updated_at: '2026-08-19T00:00:00Z' }),
    run('run-b', { customer_id: 'cust-a', customer_name: 'Alpha', updated_at: '2026-08-22T00:00:00Z' }),
    run('run-a', { customer_id: 'cust-a', customer_name: 'Alpha', updated_at: '2026-08-22T00:00:00Z' }),
    run('run-parent', { customer_id: 'cust-a', customer_name: 'Alpha', updated_at: '2026-08-21T00:00:00Z' }),
    run('run-child-old', { customer_id: 'cust-a', customer_name: 'Alpha', run_kind: 'artifact_revision', parent_run_id: 'run-parent', updated_at: '2026-08-23T00:00:00Z' }),
    run('run-child-new', { customer_id: 'cust-a', customer_name: 'Alpha', run_kind: 'artifact_revision', parent_run_id: 'run-parent', updated_at: '2026-08-24T00:00:00Z' }),
  ];
  const before = structuredClone(runs);

  const library = buildWorkLibrary(runs, { view: 'all' });

  assert.deepEqual(library.groups.map((group) => group.customerKey), ['cust-a', 'cust-z']);
  assert.deepEqual(library.groups[0].runs.map((item) => item.run_id), ['run-a', 'run-b', 'run-parent']);
  assert.deepEqual(library.groups[0].runs[2].children.map((item) => item.run_id), ['run-child-new', 'run-child-old']);
  assert.deepEqual(runs, before);
});

test('opaque customer label comes from the newest Run with a deterministic Run-ID tie break', () => {
  const runs = [
    run('run-old', {
      customer_id: 'cust-label',
      customer_name: 'Old Label',
      updated_at: '2026-08-20T00:00:00Z',
    }),
    run('run-b', {
      customer_id: 'cust-label',
      customer_name: 'Tie B Label',
      updated_at: '2026-08-22T00:00:00Z',
    }),
    run('run-a', {
      customer_id: 'cust-label',
      customer_name: 'Tie A Label',
      updated_at: '2026-08-22T00:00:00Z',
    }),
  ];

  const group = buildWorkLibrary(runs, { view: 'all' }).groups[0];
  assert.equal(group.customerLabel, 'Tie A Label');
});

test('group and Run ordering uses deterministic code-point order instead of machine locale', () => {
  const runs = [
    run('run-lower', { customer_id: 'cust-lower', customer_name: 'a' }),
    run('run-upper', { customer_id: 'cust-upper', customer_name: 'B' }),
    run('run-b', { customer_id: 'cust-same', customer_name: 'Same' }),
    run('run-A', { customer_id: 'cust-same', customer_name: 'Same' }),
  ];

  const groups = buildWorkLibrary(runs, { view: 'all' }).groups;
  assert.deepEqual(groups.map((group) => group.customerLabel), ['B', 'Same', 'a']);
  assert.deepEqual(groups.find((group) => group.customerKey === 'cust-same').runs.map((item) => item.run_id), [
    'run-A',
    'run-b',
  ]);
});

test('deriveWorkLibraryMetrics uses user-language counts without inflating real template outcomes', () => {
  const runs = [
    run('run-1', {
      artifact_count: 2,
      reviewed_count: 2,
      artifacts: [artifact('artifact-1a'), artifact('artifact-1b')],
      template_learning: { state: 'active', active_outcome_count: 1 },
      template_references: [{ template_uid: 'tpl-a' }],
    }),
    run('run-2', {
      preference: { decision: 'none', winner_artifact_id: null },
      template_learning: { state: 'deferred', active_outcome_count: 0 },
      template_references: [{ template_uid: 'tpl-b' }],
    }),
    run('run-3', {
      artifact_count: 2,
      reviewed_count: 1,
      preference: { decision: 'pending', winner_artifact_id: null },
      artifacts: [artifact('artifact-3a'), artifact('artifact-3b', { reviewed: false })],
      template_learning: { state: 'active', active_outcome_count: 1 },
      template_references: [{ template_uid: 'tpl-a' }],
    }),
    run('run-4', {
      template_learning: { state: 'active', active_outcome_count: 1 },
      template_references: [{ template_uid: 'tpl-c' }],
    }),
  ];
  const before = structuredClone(runs);

  assert.deepEqual(deriveWorkLibraryMetrics(runs), {
    reviewed: { label: '已评分作品', value: 5, total: 6 },
    finalChoice: { label: '已完成最终选择', value: 3, total: 4 },
    completeTemplateLoop: { label: '已形成完整模板闭环', value: 3, total: 4 },
    templatesWithRealOutcomes: { label: '有真实结果的模板', value: 2 },
  });
  assert.deepEqual(runs, before);
});

test('degraded template evidence is surfaced separately from a truthful zero', () => {
  const metrics = deriveWorkLibraryMetrics([
    run('run-active', {
      template_learning: { state: 'active', active_outcome_count: 1 },
      template_references: [{ template_uid: 'tpl-active' }],
    }),
    run('run-degraded', {
      template_learning: { state: 'degraded', reason: 'selection_projection_invalid', active_outcome_count: null },
      template_references: [{ template_uid: 'tpl-unknown' }],
    }),
  ]);

  assert.deepEqual(metrics.completeTemplateLoop, {
    label: '已形成完整模板闭环',
    value: 1,
    total: 2,
    evidence_state: 'degraded',
    degraded_run_count: 1,
  });
  assert.deepEqual(metrics.templatesWithRealOutcomes, {
    label: '有真实结果的模板',
    value: 1,
    evidence_state: 'degraded',
    degraded_run_count: 1,
  });
});

test('templates-with-real-outcomes uses explicit attribution and only one-template catalog fallback', () => {
  const runs = [
    run('run-explicit', {
      template_learning: {
        state: 'active',
        active_outcome_count: 1,
        template_uids: ['tpl-explicit'],
      },
      template_references: [{ template_uid: 'tpl-noise' }],
    }),
    run('run-single-fallback', {
      template_learning: { state: 'active', active_outcome_count: 1 },
      template_references: [{ template_uid: 'tpl-single' }],
    }),
    run('run-multi-deferred', {
      template_learning: { state: 'active', active_outcome_count: 1 },
      template_references: [{ template_uid: 'tpl-multi-a' }, { template_uid: 'tpl-multi-b' }],
    }),
    run('run-explicit-multi-deferred', {
      template_learning: {
        state: 'active',
        active_outcome_count: 1,
        template_uids: ['tpl-explicit-a', 'tpl-explicit-b'],
      },
      template_references: [],
    }),
    run('run-manual-deferred', {
      template_learning: { state: 'active', active_outcome_count: 1 },
      template_references: [{ template_uid: 'tpl-manual', source_type: 'manual_upload' }],
    }),
  ];

  const metrics = deriveWorkLibraryMetrics(runs);
  assert.deepEqual(metrics.completeTemplateLoop, {
    label: '已形成完整模板闭环',
    value: 2,
    total: 5,
  });
  assert.equal(metrics.templatesWithRealOutcomes.value, 2);
});

test('library DTOs deep-clone preference, Artifact metadata, and template-learning evidence', () => {
  const runs = [run('run-deep-clone', {
    preference: {
      decision: 'winner',
      winner_artifact_id: 'artifact-deep',
      evidence: { event_ids: ['preference-event-1'] },
    },
    artifacts: [artifact('artifact-deep', {
      is_winner: true,
      metadata: { tags: ['portrait'], dimensions: { width: 1024 } },
    })],
    template_learning: {
      state: 'active',
      active_outcome_count: 1,
      attribution: { outcome_ids: ['outcome-1'] },
    },
  })];

  const dto = rootRuns(buildWorkLibrary(runs, { view: 'all' }))[0];
  dto.preference.evidence.event_ids.push('changed');
  dto.artifacts[0].metadata.tags.push('changed');
  dto.artifacts[0].metadata.dimensions.width = 1;
  dto.template_learning.attribution.outcome_ids.push('changed');

  assert.deepEqual(runs[0].preference.evidence.event_ids, ['preference-event-1']);
  assert.deepEqual(runs[0].artifacts[0].metadata, {
    tags: ['portrait'],
    dimensions: { width: 1024 },
  });
  assert.deepEqual(runs[0].template_learning.attribution.outcome_ids, ['outcome-1']);
});

test('corrupt Artifact and review counts normalize conservatively for pending state and metrics', () => {
  const runs = [
    run('run-corrupt-boolean', {
      artifact_count: true,
      reviewed_count: true,
      artifacts: [artifact('artifact-unreviewed', { reviewed: false })],
    }),
    run('run-corrupt-fraction', {
      artifact_count: 2.5,
      reviewed_count: -4,
      artifacts: [artifact('artifact-reviewed', { reviewed: true })],
    }),
  ];

  assert.equal(isWorkLibraryPending(runs[0]), true);
  assert.deepEqual(deriveWorkLibraryMetrics(runs).reviewed, {
    label: '已评分作品',
    value: 1,
    total: 2,
  });
});
