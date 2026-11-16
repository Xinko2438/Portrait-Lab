const VIEWS = new Set(['list', 'import', 'detail']);
const STATUSES = new Set(['all', 'pending_review', 'pending_choice', 'completed']);
const SORTS = new Set(['newest', 'oldest']);
const COMPLETED_DECISIONS = new Set(['winner', 'none']);

function normalizedText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedCount(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function eventValue(event, key) {
  return event?.value ?? event?.[key];
}

export function createHistoryWorkspaceState(seed = {}) {
  const source = seed && typeof seed === 'object' ? seed : {};
  const requestedView = VIEWS.has(source.view) ? source.view : 'list';
  const detailRunId = normalizedText(source.detailRunId);
  const view = requestedView === 'detail' && !detailRunId ? 'list' : requestedView;

  return {
    view,
    query: normalizedText(source.query),
    customerKey: normalizedText(source.customerKey),
    status: STATUSES.has(source.status) ? source.status : 'all',
    sort: SORTS.has(source.sort) ? source.sort : 'newest',
    detailRunId: view === 'detail' ? detailRunId : null,
  };
}

export function transitionHistoryWorkspace(state, event = {}) {
  const current = createHistoryWorkspaceState(state);

  switch (event?.type) {
    case 'SET_QUERY':
      return createHistoryWorkspaceState({ ...current, query: eventValue(event, 'query') });
    case 'SET_CUSTOMER':
      return createHistoryWorkspaceState({ ...current, customerKey: eventValue(event, 'customerKey') });
    case 'SET_STATUS':
      return createHistoryWorkspaceState({ ...current, status: eventValue(event, 'status') });
    case 'SET_SORT':
      return createHistoryWorkspaceState({ ...current, sort: eventValue(event, 'sort') });
    case 'OPEN_IMPORT':
      return createHistoryWorkspaceState({ ...current, view: 'import', detailRunId: null });
    case 'OPEN_DETAIL': {
      const runId = normalizedText(eventValue(event, 'runId'));
      return createHistoryWorkspaceState({
        ...current,
        view: runId ? 'detail' : 'list',
        detailRunId: runId || null,
      });
    }
    case 'BACK_TO_LIST':
      return createHistoryWorkspaceState({ ...current, view: 'list', detailRunId: null });
    case 'RESET_FILTERS':
      return createHistoryWorkspaceState({
        ...current,
        query: '',
        customerKey: '',
        status: 'all',
        sort: 'newest',
      });
    default:
      return current;
  }
}

export function deriveHistoryRunState(run = {}) {
  const artifactCount = normalizedCount(
    run?.artifact_count,
    Array.isArray(run?.artifacts) ? run.artifacts.length : 0,
  );
  const reviewedCount = normalizedCount(
    run?.reviewed_count,
    Array.isArray(run?.artifacts)
      ? run.artifacts.filter((artifact) => artifact?.reviewed).length
      : 0,
  );

  if (reviewedCount < artifactCount) return 'pending_review';

  const decision = normalizedText(
    run?.preference?.decision ?? run?.latest_preference?.decision,
  ).toLowerCase();
  return COMPLETED_DECISIONS.has(decision) || normalizedText(run?.status).toLowerCase() === 'completed'
    ? 'completed'
    : 'pending_choice';
}

export function historyCustomerKey(run = {}) {
  const customerId = normalizedText(run?.customer_id);
  if (customerId) return customerId;
  return normalizedText(run?.customer_name).toLowerCase();
}

export function historyCustomerOptions(runs = []) {
  if (!Array.isArray(runs)) return [];

  const seen = new Set();
  const options = [];
  for (const run of runs) {
    const key = historyCustomerKey(run);
    if (!key || seen.has(key)) continue;
    const label = normalizedText(run?.customer_name) || key;
    seen.add(key);
    options.push({ key, label, index: options.length });
  }

  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  return options
    .sort((left, right) => collator.compare(left.label, right.label) || left.index - right.index)
    .map(({ key, label }) => ({ key, label }));
}

function searchableText(run) {
  return [
    run?.customer_name,
    run?.batch_label,
    run?.history_import?.batch_label,
    run?.intended_use,
    run?.use_case,
    run?.customer_context?.intended_use,
    run?.prompt,
    run?.prompt_text,
  ]
    .map((value) => normalizedText(value).toLowerCase())
    .filter(Boolean)
    .join('\n');
}

function historyTimestamp(run) {
  for (const value of [run?.updated_at, run?.created_at]) {
    const timestamp = Date.parse(normalizedText(value));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function compareRunId(left, right) {
  const leftId = normalizedText(left?.run_id);
  const rightId = normalizedText(right?.run_id);
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

export function filterAndSortHistoryRuns(runs = [], state = {}) {
  if (!Array.isArray(runs)) return [];

  const normalizedState = createHistoryWorkspaceState(state);
  const query = normalizedState.query.toLowerCase();
  const filtered = runs.filter((run) => {
    if (query && !searchableText(run).includes(query)) return false;
    if (normalizedState.customerKey && historyCustomerKey(run) !== normalizedState.customerKey) return false;
    if (normalizedState.status !== 'all' && deriveHistoryRunState(run) !== normalizedState.status) return false;
    return true;
  });

  const direction = normalizedState.sort === 'oldest' ? 1 : -1;
  return filtered.sort((left, right) => {
    const timeDifference = historyTimestamp(left) - historyTimestamp(right);
    return timeDifference ? timeDifference * direction : compareRunId(left, right);
  });
}
