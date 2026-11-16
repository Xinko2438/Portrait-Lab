export const COMPLETED_RUN_NOTICE = '上次任务已完成，可从历史结果重新查看。';
export const INVALID_RUN_NOTICE = '原任务无法打开，已返回新建任务。';

const RUN_ID = /^run-[a-zA-Z0-9-]+$/;
const FINAL_PREFERENCES = new Set(['winner', 'none']);
const RESULT_STATUSES = new Set(['submitted', 'submission_uncertain', 'provider_rate_limited', 'provider_error']);

export function parseRunLocation(search = '') {
  const params = new URLSearchParams(String(search || ''));
  const candidate = params.get('run');
  const runId = RUN_ID.test(candidate || '') ? candidate : null;
  return { runId, fromHistory: Boolean(runId && params.get('from') === 'history') };
}

export function isRunComplete(manifest = {}) {
  return manifest.status === 'completed' || FINAL_PREFERENCES.has(String(manifest.preference?.decision || ''));
}

export function suggestedStage(manifest = {}) {
  if ((manifest.artifacts || []).length) return 'review';
  if (RESULT_STATUSES.has(manifest.status)) return 'results';
  return 'generation';
}

export function resolveRunStartup({ manifest = {}, fromHistory = false } = {}) {
  if (!fromHistory && isRunComplete(manifest)) {
    return { mode: 'new', stage: 'references', notice: COMPLETED_RUN_NOTICE };
  }
  return { mode: 'run', stage: suggestedStage(manifest), notice: '' };
}

export function shouldClearRunUrlAfterPreference(decision, fromHistory = false) {
  return !fromHistory && FINAL_PREFERENCES.has(String(decision || ''));
}
