import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { createTemplateSelection } from '../src/template-selection.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fixturePath = join(root, 'web', 'fixtures', 'template-selection-benchmark.json');
const catalogPath = join(root, 'data', 'projections', 'template-catalog.json');
const COMPONENTS = [
  'style_use_case',
  'composition_angle',
  'customer_compatibility',
  'text_relevance',
  'safety_stability',
  'observational_prior',
];
const FORBIDDEN_KEYS = new Set([
  'absolute_path',
  'canonical_path',
  'customer_image',
  'customer_images',
  'face_embedding',
  'identity_embedding',
  'identity_vector',
  'source_path',
]);

function stableCandidateEvidence(selection) {
  return {
    top10: selection.top10.map((item) => ({
      template_uid: item.template_uid,
      component_scores: item.component_scores,
      relevance_score: item.relevance_score,
    })),
    top4: selection.top4.map((item) => ({
      template_uid: item.template_uid,
      reference_image_sha256: item.reference_image.sha256,
    })),
  };
}

function collectForbiddenEvidence(value, current = '$', findings = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenEvidence(item, `${current}[${index}]`, findings));
    return findings;
  }
  if (!value || typeof value !== 'object') return findings;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) findings.push(`${current}.${key}`);
    collectForbiddenEvidence(child, `${current}.${key}`, findings);
  }
  return findings;
}

function verifyCandidateEvidence(selection) {
  const candidates = [...selection.top10, ...selection.top4];
  for (const candidate of candidates) {
    const componentKeys = Object.keys(candidate.component_scores || {}).sort();
    if (JSON.stringify(componentKeys) !== JSON.stringify([...COMPONENTS].sort())) {
      throw new Error(`${candidate.template_uid} is missing score components`);
    }
    if (!Array.isArray(candidate.matched_evidence) || candidate.matched_evidence.length !== COMPONENTS.length) {
      throw new Error(`${candidate.template_uid} is missing matched evidence`);
    }
    if (!String(candidate.reason || '').trim()) throw new Error(`${candidate.template_uid} is missing an explanation`);
  }
}

function verifySelectionInvariants({ fixtureCase, selection, replay }) {
  const rejected = new Set(selection.exclusions.map((item) => item.template_uid));
  const hardViolations = [...selection.top10, ...selection.top4]
    .map((item) => item.template_uid)
    .filter((uid) => rejected.has(uid));
  if (fixtureCase.invariants.no_hard_violations && hardViolations.length) {
    throw new Error(`${fixtureCase.case_id} returned hard-filter-rejected templates: ${hardViolations.join(', ')}`);
  }

  const uniqueTop10Images = new Set(selection.top10.map((item) => item.reference_image.sha256)).size;
  const uniqueTop4Images = new Set(selection.top4.map((item) => item.reference_image.sha256)).size;
  const uniquenessRequired = fixtureCase.invariants.unique_top4_images_when_possible
    && selection.top4.length === 4
    && uniqueTop10Images >= 4;
  if (uniquenessRequired && uniqueTop4Images !== 4) {
    throw new Error(`${fixtureCase.case_id} returned duplicate Top4 images despite four unique eligible images`);
  }

  if (fixtureCase.invariants.deterministic
    && JSON.stringify(stableCandidateEvidence(selection)) !== JSON.stringify(stableCandidateEvidence(replay))) {
    throw new Error(`${fixtureCase.case_id} replay changed ordered candidate evidence`);
  }
  verifyCandidateEvidence(selection);

  const serialized = JSON.stringify(selection);
  if (/[A-Za-z]:\\/.test(serialized) || serialized.includes(root)) {
    throw new Error(`${fixtureCase.case_id} leaked an absolute filesystem path`);
  }
  const forbiddenEvidence = collectForbiddenEvidence(selection);
  if (forbiddenEvidence.length) {
    throw new Error(`${fixtureCase.case_id} stored prohibited identity/path fields: ${forbiddenEvidence.join(', ')}`);
  }

  return {
    status: selection.status,
    eligible_count: selection.filter_summary.eligible_count,
    rejected_count: selection.filter_summary.rejected_count,
    top10_count: selection.top10.length,
    top4_count: selection.top4.length,
    unique_top10_images: uniqueTop10Images,
    unique_top4_images: uniqueTop4Images,
    hard_violation_count: hardViolations.length,
    explanations_complete: true,
    deterministic_replay: true,
    privacy_scan_passed: true,
  };
}

async function main() {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  if (catalog.templates.length !== fixture.catalog_expected_count) {
    throw new Error(`Expected ${fixture.catalog_expected_count} templates, found ${catalog.templates.length}`);
  }

  const results = [];
  for (const fixtureCase of fixture.cases) {
    const startedAt = performance.now();
    const created = await createTemplateSelection({
      root,
      idempotencyKey: `benchmark-v1:${fixtureCase.case_id}`,
      taskBrief: fixtureCase.task_brief,
    });
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const replay = await createTemplateSelection({
      root,
      idempotencyKey: `benchmark-v1:${fixtureCase.case_id}`,
      taskBrief: fixtureCase.task_brief,
    });
    if (!replay.idempotent_replay) throw new Error(`${fixtureCase.case_id} did not replay idempotently`);
    if (durationMs >= 2000) throw new Error(`${fixtureCase.case_id} exceeded the 2000ms benchmark budget: ${durationMs}ms`);
    results.push({
      case_id: fixtureCase.case_id,
      selection_id: created.selection.selection_id,
      first_call_replayed_existing_selection: created.idempotent_replay,
      duration_ms: durationMs,
      ...verifySelectionInvariants({
        fixtureCase,
        selection: created.selection,
        replay: replay.selection,
      }),
    });
  }

  const durations = results.map((item) => item.duration_ms);
  const report = {
    schema_version: 'ai-img-gen.template-selection-benchmark-report.v1',
    benchmark_suite: fixture.schema_version,
    catalog_count: catalog.templates.length,
    case_count: results.length,
    passed_case_count: results.length,
    max_duration_ms: Math.max(...durations),
    average_duration_ms: Math.round((durations.reduce((sum, item) => sum + item, 0) / durations.length) * 100) / 100,
    all_hard_filters_passed: results.every((item) => item.hard_violation_count === 0),
    all_deterministic: results.every((item) => item.deterministic_replay),
    all_explanations_complete: results.every((item) => item.explanations_complete),
    all_privacy_scans_passed: results.every((item) => item.privacy_scan_passed),
    results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
