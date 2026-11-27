import { deriveHistoryRunState } from './history-workspace.js';

const LIBRARY_VIEWS = new Set(['pending', 'pending_review', 'pending_choice', 'completed', 'final', 'qualified', 'rejected', 'all']);
const PROGRESS_VIEWS = new Set(['pending_review', 'pending_choice', 'completed']);
const FINAL_DECISIONS = new Set(['winner', 'none']);

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function deepClone(value) {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Fall through for non-cloneable, JSON-shaped projection values.
    }
  }
  if (Array.isArray(value)) return value.map((item) => deepClone(item));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepClone(item)]));
}

function count(value, fallback = 0) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function compareText(left, right) {
  const leftText = clean(left);
  const rightText = clean(right);
  if (leftText < rightText) return -1;
  if (leftText > rightText) return 1;
  return 0;
}

function artifactsOf(run = {}) {
  return Array.isArray(run?.artifacts) ? run.artifacts : [];
}

function artifactCount(run = {}) {
  return Math.max(artifactsOf(run).length, count(run?.artifact_count));
}

function reviewedCount(run = {}) {
  const fallback = artifactsOf(run).filter((artifact) => artifact?.reviewed === true).length;
  return Math.min(artifactCount(run), count(run?.reviewed_count, fallback));
}

function preferenceOf(run = {}) {
  const preference = run?.preference ?? run?.latest_preference;
  return preference && typeof preference === 'object' ? preference : {};
}

function hasCurrentPreference(run = {}) {
  return Boolean(
    (run?.preference && typeof run.preference === 'object')
    || (run?.latest_preference && typeof run.latest_preference === 'object'),
  );
}

function preferenceDecision(run = {}) {
  return clean(preferenceOf(run).decision).toLowerCase();
}

function winnerArtifactId(run = {}) {
  return clean(preferenceOf(run).winner_artifact_id);
}

function isWinner(run, artifact) {
  const winnerId = winnerArtifactId(run);
  if (hasCurrentPreference(run)) return Boolean(winnerId && clean(artifact?.artifact_id) === winnerId);
  return artifact?.is_winner === true;
}

function isQualified(artifact) {
  if (typeof artifact?.preference_eligible === 'boolean') return artifact.preference_eligible;
  return artifact?.gate_qualified === true
    || clean(artifact?.gate_state).toLowerCase() === 'qualified';
}

function timestamp(run = {}) {
  for (const value of [run?.updated_at, run?.created_at]) {
    const parsed = Date.parse(clean(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function compareRuns(left, right) {
  const timeDifference = timestamp(right) - timestamp(left);
  if (timeDifference) return timeDifference;
  return compareText(left?.run_id, right?.run_id);
}

function strongCustomerIdentity(run = {}) {
  const ids = new Set();
  for (const value of [
    run?.customer_id,
    run?.customer_identity_source?.customer_id,
    run?.customer_identity?.customer_id,
    run?.identity_source?.customer_id,
    run?.customer_scope?.customer_id,
    run?.customer_context?.customer_id,
    run?.customer?.customer_id,
    run?.customer?.id,
  ]) {
    const normalized = clean(value);
    if (normalized) ids.add(normalized);
  }
  if (ids.size > 1) return { state: 'invalid_internal_conflict', id: '', ids: [...ids].sort(compareText) };
  if (ids.size === 1) return { state: 'valid', id: [...ids][0], ids: [...ids] };
  return { state: 'missing', id: '', ids: [] };
}

function opaqueCustomerId(run = {}) {
  return strongCustomerIdentity(run).id;
}

function customerLabel(run = {}) {
  for (const value of [
    run?.customer_name,
    run?.customer?.display_name,
    run?.customer_label,
    run?.customer_scope?.customer_name,
    run?.customer_scope?.display_name,
    run?.customer_identity_source?.customer_name,
    run?.customer_identity_source?.display_name,
  ]) {
    const normalized = clean(value);
    if (normalized) return normalized;
  }
  return opaqueCustomerId(run) || '未知客户';
}

function normalizeView(view) {
  const normalized = clean(view).toLowerCase();
  return LIBRARY_VIEWS.has(normalized) ? normalized : 'all';
}

function partitionHistoryArtifacts(run) {
  const artifacts = artifactsOf(run);
  const decision = preferenceDecision(run);
  if (decision === 'none') return { visible: [], rejected: artifacts };
  const excluded = preferenceOf(run).excluded_artifact_ids;
  const excludedIds = new Set(Array.isArray(excluded) ? excluded : []);
  const visible = [];
  const rejected = [];
  for (const artifact of artifacts) {
    const explicitlyExcluded = excludedIds.has(artifact.artifact_id)
      && (decision === 'winner' || artifact.reviewed !== false);
    const failed = explicitlyExcluded
      || (artifact.reviewed === true && artifact.preference_eligible === false);
    (failed && !isWinner(run, artifact) ? rejected : visible).push(artifact);
  }
  return { visible, rejected };
}

function selectedArtifacts(run, view, { visible, rejected }) {
  if (view === 'rejected') return rejected;
  if (view === 'final') {
    if (preferenceDecision(run) !== 'winner') return [];
    return visible.filter((artifact) => isWinner(run, artifact));
  }
  if (view === 'qualified') return visible.filter((artifact) => isQualified(artifact) && !isWinner(run, artifact));
  return visible;
}

function matchesView(run, view, artifacts) {
  if (view === 'all') return true;
  if (view === 'pending') return isWorkLibraryPending(run);
  if (PROGRESS_VIEWS.has(view)) return deriveHistoryRunState(run) === view;
  return artifacts.length > 0;
}

function projectRun(run, view) {
  const clonedRun = deepClone(run);
  const partition = partitionHistoryArtifacts(clonedRun);
  const artifacts = selectedArtifacts(clonedRun, view, partition);
  const runKind = clean(run?.run_kind) || 'generation';
  return {
    ...clonedRun,
    run_kind: runKind,
    artifacts,
    rejected_artifact_count: partition.rejected.length,
    children: [],
    customerIdentityState: strongCustomerIdentity(run).state,
    relationLabel: runKind === 'artifact_revision' ? '修改版' : '',
    relationState: runKind === 'artifact_revision' ? 'unresolved_revision' : 'root',
    viewContextOnly: false,
    matchesView: matchesView(run, view, artifacts),
  };
}

export function workLibraryCustomerKey(run = {}) {
  const identity = strongCustomerIdentity(run);
  if (identity.state === 'invalid_internal_conflict') {
    return `invalid-customer:${clean(run?.run_id) || 'unknown'}`;
  }
  const customerId = identity.id;
  if (customerId) return customerId;
  return customerLabel(run) === '未知客户' ? '' : `legacy:${customerLabel(run).toLowerCase()}`;
}

export function isWorkLibraryPending(run = {}) {
  if (run?.review_flow === 'score-only-v1') return deriveHistoryRunState(run) === 'pending_review';
  if (reviewedCount(run) < artifactCount(run)) return true;
  return !FINAL_DECISIONS.has(preferenceDecision(run));
}

function structuralParentId(entry, entriesById) {
  if (clean(entry?.run_kind).toLowerCase() !== 'artifact_revision') return '';
  const parentId = clean(entry?.parent_run_id);
  return parentId && entriesById.has(parentId) ? parentId : '';
}

function parentCycleIds(entriesById) {
  const cycles = new Set();
  const finished = new Set();

  for (const startingId of entriesById.keys()) {
    if (finished.has(startingId)) continue;
    const path = [];
    const positions = new Map();
    let runId = startingId;

    while (runId && entriesById.has(runId) && !finished.has(runId)) {
      if (positions.has(runId)) {
        for (const cycleId of path.slice(positions.get(runId))) cycles.add(cycleId);
        break;
      }
      positions.set(runId, path.length);
      path.push(runId);
      runId = structuralParentId(entriesById.get(runId), entriesById);
    }

    for (const pathId of path) finished.add(pathId);
  }

  return cycles;
}

function resolveParentRelations(entriesById) {
  const cycles = parentCycleIds(entriesById);
  const validParents = new Map();

  for (const [runId, entry] of entriesById) {
    if (clean(entry.run_kind).toLowerCase() !== 'artifact_revision') {
      entry.relationState = 'root';
      continue;
    }
    if (cycles.has(runId)) {
      entry.relationState = 'invalid_parent_cycle';
      continue;
    }

    const parentId = clean(entry.parent_run_id);
    if (!parentId) {
      entry.relationState = 'invalid_missing_parent_id';
      continue;
    }
    const parent = entriesById.get(parentId);
    if (!parent) {
      entry.relationState = 'invalid_parent_not_found';
      continue;
    }

    const childCustomerId = opaqueCustomerId(entry);
    const parentCustomerId = opaqueCustomerId(parent);
    if (!childCustomerId || !parentCustomerId) {
      entry.relationState = 'invalid_customer_identity';
      continue;
    }
    if (childCustomerId !== parentCustomerId) {
      entry.relationState = 'invalid_customer_mismatch';
      continue;
    }

    entry.relationState = 'nested_revision';
    validParents.set(runId, parentId);
  }

  return validParents;
}

function authoritativeCustomerRecords(entriesById) {
  const records = new Map();
  for (const entry of entriesById.values()) {
    const key = workLibraryCustomerKey(entry) || 'unknown';
    const existing = records.get(key);
    if (!existing || compareRuns(entry, existing.entry) < 0) {
      records.set(key, {
        entry,
        label: customerLabel(entry),
        customerId: opaqueCustomerId(entry) || null,
      });
    }
  }
  return records;
}

function attributableTemplateUid(run, learning) {
  const hasExplicitAttribution = Object.prototype.hasOwnProperty.call(learning, 'template_uid')
    || Object.prototype.hasOwnProperty.call(learning, 'template_uids');
  if (hasExplicitAttribution) {
    const explicitIds = new Set([
      learning.template_uid,
      ...(Array.isArray(learning.template_uids) ? learning.template_uids : []),
    ].map((value) => clean(value)).filter(Boolean));
    return explicitIds.size === 1 ? [...explicitIds][0] : '';
  }

  const catalogReferences = (Array.isArray(run?.template_references) ? run.template_references : [])
    .filter((reference) => (
      clean(reference?.template_uid)
      && (!clean(reference?.source_type)
        || clean(reference?.source_type).toLowerCase() === 'catalog_template')
    ));
  return catalogReferences.length === 1 ? clean(catalogReferences[0].template_uid) : '';
}

export function buildWorkLibrary(runs = [], options = {}) {
  const sourceRuns = Array.isArray(runs) ? runs : [];
  const view = normalizeView(typeof options === 'string' ? options : options?.view);
  const chronological = ['newest', 'oldest'].includes(options?.sort);
  const direction = options?.sort === 'oldest' ? 1 : -1;
  const dates = (entry) => {
    const created = Date.parse(clean(entry?.created_at));
    return Number.isFinite(created) ? created : timestamp(entry);
  };
  const compareDates = (left, right) => direction * (dates(left) - dates(right)) || compareText(left?.run_id, right?.run_id);
  const entriesById = new Map();

  for (const run of sourceRuns) {
    const runId = clean(run?.run_id);
    if (!runId || entriesById.has(runId)) continue;
    entriesById.set(runId, projectRun(run, view));
  }
  const validParents = resolveParentRelations(entriesById);
  const customerRecords = authoritativeCustomerRecords(entriesById);

  const includedIds = new Set(
    [...entriesById.entries()]
      .filter(([, entry]) => entry.matchesView)
      .map(([runId]) => runId),
  );

  for (const runId of [...includedIds]) {
    let parentId = validParents.get(runId) || '';
    const visited = new Set([runId]);
    while (parentId && !visited.has(parentId)) {
      includedIds.add(parentId);
      visited.add(parentId);
      parentId = validParents.get(parentId) || '';
    }
  }

  const included = new Map();
  for (const runId of includedIds) {
    const entry = entriesById.get(runId);
    const viewContextOnly = !entry.matchesView;
    included.set(runId, {
      ...entry,
      artifacts: viewContextOnly ? [] : entry.artifacts.map((artifact) => deepClone(artifact)),
      children: [],
      viewContextOnly,
    });
  }

  const roots = [];
  for (const entry of included.values()) {
    const parentId = validParents.get(clean(entry.run_id)) || '';
    if (parentId && included.has(parentId)) {
      included.get(parentId).children.push(entry);
    } else {
      roots.push(entry);
    }
  }

  const datedEntries = new Map();
  const compareEntries = chronological
    ? (left, right) => compareDates(datedEntries.get(left) || left, datedEntries.get(right) || right)
    : compareRuns;
  const sortTree = (entry) => {
    entry.children.forEach(sortTree);
    entry.children.sort(compareEntries);
    if (chronological) {
      let anchor = entry.matchesView ? entry : null;
      for (const child of entry.children) {
        const candidate = datedEntries.get(child);
        if (candidate && (!anchor || compareDates(candidate, anchor) < 0)) anchor = candidate;
      }
      datedEntries.set(entry, anchor);
    }
  };
  roots.forEach(sortTree);
  roots.sort(compareEntries);

  const groupMap = new Map();
  for (const entry of roots) {
    const key = workLibraryCustomerKey(entry) || 'unknown';
    const authority = customerRecords.get(key);
    const label = authority?.label || customerLabel(entry);
    const existing = groupMap.get(key);
    if (!existing) {
      groupMap.set(key, {
        customerKey: key,
        customerId: authority?.customerId || opaqueCustomerId(entry) || null,
        customerLabel: label,
        runs: [entry],
      });
      continue;
    }
    existing.runs.push(entry);
  }

  const groups = [...groupMap.values()]
    .map((group) => ({ ...group, runs: group.runs.sort(compareEntries) }))
    .sort((left, right) => (
      (chronological ? compareEntries(left.runs[0], right.runs[0]) : 0)
      || compareText(left.customerLabel, right.customerLabel)
      || compareText(left.customerKey, right.customerKey)
    ));

  return {
    view,
    groups,
    runCount: [...included.values()].filter((entry) => entry.matchesView).length,
    artifactCount: [...included.values()]
      .filter((entry) => entry.matchesView)
      .reduce((total, entry) => total + entry.artifacts.length, 0),
  };
}

export function deriveWorkLibraryMetrics(runs = []) {
  const sourceRuns = Array.isArray(runs) ? runs : [];
  let totalArtifacts = 0;
  let totalReviewed = 0;
  let finalChoices = 0;
  let completeLoops = 0;
  let degradedRunCount = 0;
  const templatesWithOutcomes = new Set();

  for (const run of sourceRuns) {
    totalArtifacts += artifactCount(run);
    totalReviewed += reviewedCount(run);
    if (FINAL_DECISIONS.has(preferenceDecision(run))) finalChoices += 1;

    const learning = run?.template_learning && typeof run.template_learning === 'object'
      ? run.template_learning
      : {};
    if (clean(learning.state).toLowerCase() === 'degraded') degradedRunCount += 1;
    const hasActiveOutcome = clean(learning.state).toLowerCase() === 'active'
      && count(learning.active_outcome_count ?? learning.activeOutcomeCount) > 0;
    if (!hasActiveOutcome) continue;

    const templateUid = attributableTemplateUid(run, learning);
    if (!templateUid) continue;
    completeLoops += 1;
    templatesWithOutcomes.add(templateUid);
  }

  const evidenceState = degradedRunCount > 0
    ? { evidence_state: 'degraded', degraded_run_count: degradedRunCount }
    : {};
  return {
    reviewed: { label: '已评分作品', value: totalReviewed, total: totalArtifacts },
    finalChoice: { label: '已完成最终选择', value: finalChoices, total: sourceRuns.length },
    completeTemplateLoop: { label: '已形成完整模板闭环', value: completeLoops, total: sourceRuns.length, ...evidenceState },
    templatesWithRealOutcomes: { label: '有真实结果的模板', value: templatesWithOutcomes.size, ...evidenceState },
  };
}
