import {
  APPEND_ONLY_EVENT_VERSION,
  buildAppendOnlyEvent,
  buildIdempotencyKey,
  hashCanonicalValue,
} from './review-suggestion.mjs';

export const PROMPT_EXPERIMENT_VERSION = 'ai-img-gen.prompt-experiment.v1';
export const PROMPT_EXPERIMENT_AGGREGATE_VERSION = 'ai-img-gen.prompt-experiment-aggregate.v1';

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function normalizeMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('metrics is required and must be an object');
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) throw new Error('metrics must contain at least one metric');
  const normalized = {};
  for (const [name, metric] of entries) {
    const key = requireText(name, 'metric name');
    if (typeof metric !== 'number' || !Number.isFinite(metric)) {
      throw new Error(`metric ${key} must be a finite number`);
    }
    normalized[key] = metric;
  }
  return normalized;
}

function ensureFixedClaimFields(input) {
  if (input.causal_claim !== undefined && input.causal_claim !== false) {
    throw new Error('PromptExperiment cannot make a causal claim');
  }
  if (input.claim_scope !== undefined && input.claim_scope !== 'descriptive_observation_only') {
    throw new Error('PromptExperiment claim_scope is descriptive observation only');
  }
  if (input.promotion_state !== undefined && input.promotion_state !== 'not_promoted') {
    throw new Error('PromptExperiment cannot claim promotion or auto-promote a variant');
  }
}

function experimentIdentitySource(value) {
  return {
    variant_id: value.variant_id,
    compiler_id: value.compiler_id,
    compiler_version: value.compiler_version,
    policy_id: value.policy_id,
    policy_version: value.policy_version,
    provider_id: value.provider_id,
    model_id: value.model_id,
    model_version: value.model_version,
    run_id: value.run_id,
    outcome_id: value.outcome_id,
    metrics: value.metrics,
  };
}

export function normalizePromptExperiment(input = {}) {
  if (input.schema_version !== undefined && input.schema_version !== PROMPT_EXPERIMENT_VERSION) {
    throw new Error(`schema_version must be ${PROMPT_EXPERIMENT_VERSION}`);
  }
  ensureFixedClaimFields(input);
  const core = {
    variant_id: requireText(input.variant_id, 'variant_id'),
    compiler_id: requireText(input.compiler_id, 'compiler_id'),
    compiler_version: requireText(input.compiler_version, 'compiler_version'),
    policy_id: requireText(input.policy_id, 'policy_id'),
    policy_version: requireText(input.policy_version, 'policy_version'),
    provider_id: requireText(input.provider_id, 'provider_id'),
    model_id: requireText(input.model_id, 'model_id'),
    model_version: requireText(input.model_version, 'model_version'),
    run_id: requireText(input.run_id, 'run_id'),
    outcome_id: requireText(input.outcome_id, 'outcome_id'),
    metrics: normalizeMetrics(input.metrics),
  };
  const derivedId = `prompt-experiment_${hashCanonicalValue(experimentIdentitySource(core)).slice(0, 24)}`;
  const experimentId = input.experiment_id === undefined
    ? derivedId
    : requireText(input.experiment_id, 'experiment_id');

  return Object.freeze({
    schema_version: PROMPT_EXPERIMENT_VERSION,
    experiment_id: experimentId,
    ...core,
    claim_scope: 'descriptive_observation_only',
    causal_claim: false,
    promotion_state: 'not_promoted',
  });
}

export function buildPromptExperimentEvent(input, { occurredAt } = {}) {
  const experiment = normalizePromptExperiment(input);
  return buildAppendOnlyEvent({
    eventType: 'prompt_experiment.observed',
    payload: experiment,
    idempotencySource: {
      experiment_id: experiment.experiment_id,
      run_id: experiment.run_id,
      outcome_id: experiment.outcome_id,
      variant_id: experiment.variant_id,
    },
    occurredAt,
  });
}

function unwrapExperiment(item) {
  if (item?.schema_version === APPEND_ONLY_EVENT_VERSION) {
    if (item.event_type !== 'prompt_experiment.observed') {
      throw new Error(`Unexpected append-only event type: ${item.event_type}`);
    }
    return {
      experiment: normalizePromptExperiment(item.payload),
      dedupe_key: requireText(item.idempotency_key, 'event idempotency_key'),
    };
  }
  const experiment = normalizePromptExperiment(item);
  return {
    experiment,
    dedupe_key: buildIdempotencyKey('prompt_experiment.observed', {
      experiment_id: experiment.experiment_id,
      run_id: experiment.run_id,
      outcome_id: experiment.outcome_id,
      variant_id: experiment.variant_id,
    }),
  };
}

function configurationOf(experiment) {
  return {
    compiler_id: experiment.compiler_id,
    compiler_version: experiment.compiler_version,
    policy_id: experiment.policy_id,
    policy_version: experiment.policy_version,
    provider_id: experiment.provider_id,
    model_id: experiment.model_id,
    model_version: experiment.model_version,
  };
}

function rounded(value) {
  return Math.round((value + Number.EPSILON) * 1e12) / 1e12;
}

function aggregateMetrics(experiments) {
  const valuesByMetric = new Map();
  for (const experiment of experiments) {
    for (const [metric, value] of Object.entries(experiment.metrics)) {
      if (!valuesByMetric.has(metric)) valuesByMetric.set(metric, []);
      valuesByMetric.get(metric).push(value);
    }
  }
  return Object.fromEntries(
    [...valuesByMetric.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([metric, values]) => {
        const sum = rounded(values.reduce((total, value) => total + value, 0));
        return [metric, {
          count: values.length,
          sum,
          mean: rounded(sum / values.length),
          min: Math.min(...values),
          max: Math.max(...values),
        }];
      }),
  );
}

export function aggregatePromptExperiments(items = []) {
  if (!Array.isArray(items)) throw new Error('PromptExperiment aggregation input must be an array');
  const unique = new Map();
  for (const item of items) {
    const unwrapped = unwrapExperiment(item);
    if (!unique.has(unwrapped.dedupe_key)) unique.set(unwrapped.dedupe_key, unwrapped.experiment);
  }

  const groups = new Map();
  for (const experiment of unique.values()) {
    if (!groups.has(experiment.variant_id)) groups.set(experiment.variant_id, []);
    groups.get(experiment.variant_id).push(experiment);
  }

  const variants = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([variantId, experiments]) => {
      const configurationsByHash = new Map();
      for (const experiment of experiments) {
        const configuration = configurationOf(experiment);
        configurationsByHash.set(hashCanonicalValue(configuration), configuration);
      }
      return {
        variant_id: variantId,
        observation_count: experiments.length,
        experiment_ids: [...new Set(experiments.map((item) => item.experiment_id))].sort(),
        run_ids: [...new Set(experiments.map((item) => item.run_id))].sort(),
        outcome_ids: [...new Set(experiments.map((item) => item.outcome_id))].sort(),
        configurations: [...configurationsByHash.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, configuration]) => configuration),
        metrics: aggregateMetrics(experiments),
      };
    });

  return Object.freeze({
    schema_version: PROMPT_EXPERIMENT_AGGREGATE_VERSION,
    interpretation: 'descriptive_observational_summary_only',
    causal_claim: false,
    promotion_state: 'not_promoted',
    observation_count: unique.size,
    variants,
  });
}
