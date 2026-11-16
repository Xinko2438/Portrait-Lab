import { createHash } from 'node:crypto';
import { assertTemplatesNotRejected } from './face-tag-store.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadTemplate, resolveTemplateReference } from './template-catalog.mjs';
import {
  TemplateSelectionError,
  loadTemplateSelection,
  normalizeTaskBrief,
  recordTemplateSelectionDecision,
} from './template-selection.mjs';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export class CatalogRunIntegrationError extends Error {
  constructor(code, message, { status = 409, details = [], runId = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CatalogRunIntegrationError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.runId = runId;
  }
}

function selectedDecisionEvidence(selection) {
  const decision = selection?.decision;
  if (!decision?.decision_id) {
    throw new CatalogRunIntegrationError(
      'template_not_in_selection',
      'Catalog templates require a recorded active selection decision',
      { status: 422 },
    );
  }
  const accepted = new Set(decision.accepted_template_uids || []);
  const substitutions = new Map((decision.substitutions || []).map((item) => [item.added_template_uid, item]));
  return { decision, accepted, substitutions };
}

async function assertCatalogSnapshotMatchesSelection({ root, selection }) {
  const projectionPath = join(root, 'data', 'projections', 'template-catalog.json');
  let text;
  try {
    text = (await readFile(projectionPath, 'utf8')).replace(/^\uFEFF/, '');
  } catch (error) {
    throw new CatalogRunIntegrationError('template_selection_link_failed', 'Template catalog projection is unavailable', {
      status: 503,
      details: [{ source_code: error?.code || 'catalog_unavailable' }],
      cause: error,
    });
  }
  if (sha256(text) !== selection.catalog_content_sha256) {
    throw new CatalogRunIntegrationError(
      'template_selection_link_failed',
      'Template catalog changed after the selection was recorded',
      { details: [{ source_code: 'catalog_snapshot_mismatch' }] },
    );
  }
}

function candidateEvidence(selection, templateUid) {
  return (selection.top4 || []).find((candidate) => candidate.template_uid === templateUid)
    || (selection.top10 || []).find((candidate) => candidate.template_uid === templateUid)
    || (selection.ranked_candidates || []).find((candidate) => candidate.template_uid === templateUid)
    || null;
}

function linkDecisionPayload(selection, runId) {
  const current = selection.decision;
  return {
    actor: current.actor || 'primary-user',
    accepted_template_uids: current.accepted_template_uids || [],
    removed_template_uids: current.removed_template_uids || [],
    substitutions: current.substitutions || [],
    linked_run_ids: [...new Set([...(current.linked_run_ids || []), runId])].sort(),
    notes: current.notes || '',
  };
}

function runLinkIdempotencyKey({ selectionId, runId, decisionId, baseKey = '' }) {
  const digest = sha256(stableJson({ selectionId, runId, decisionId, baseKey }));
  return `run-link:${digest.slice(0, 48)}`;
}

export async function resolveCatalogSelectionForRun({
  root,
  templateSelectionId,
  catalogTemplateUids = [],
  expectedTaskBrief = null,
}) {
  if (!catalogTemplateUids.length) return { catalogReferences: [], selection: null, selectionSnapshot: null };
  if (!templateSelectionId) {
    throw new CatalogRunIntegrationError(
      'template_not_in_selection',
      'templateSelectionId is required when catalogTemplateUids are provided',
      { status: 422 },
    );
  }

  let selection;
  try {
    selection = await loadTemplateSelection({ root, selectionId: templateSelectionId });
  } catch (error) {
    if (error instanceof TemplateSelectionError) {
      throw new CatalogRunIntegrationError('template_selection_link_failed', 'Template selection could not be loaded safely', {
        status: error.status,
        details: [{ source_code: error.code }],
        cause: error,
      });
    }
    throw error;
  }

  if (expectedTaskBrief) {
    const normalizedExpected = normalizeTaskBrief(expectedTaskBrief);
    if (stableJson(normalizedExpected) !== stableJson(selection.task_brief)) {
      throw new CatalogRunIntegrationError(
        'template_selection_stale',
        'Template selection no longer matches the current customer and task settings',
        {
          status: 409,
          details: [{
            expected_task_brief_sha256: sha256(stableJson(normalizedExpected)),
            selection_task_brief_sha256: sha256(stableJson(selection.task_brief)),
          }],
        },
      );
    }
  }

  await assertCatalogSnapshotMatchesSelection({ root, selection });
  await assertTemplatesNotRejected({root,templateUids:catalogTemplateUids});
  const { decision, accepted, substitutions } = selectedDecisionEvidence(selection);
  const requestedUids = [...new Set(catalogTemplateUids.map((value) => String(value || '').trim()).filter(Boolean))];
  if (requestedUids.length !== catalogTemplateUids.length) {
    throw new CatalogRunIntegrationError('invalid_catalog_template_uid', 'Catalog template UIDs must be non-empty and unique', { status: 400 });
  }

  const catalogReferences = [];
  for (const templateUid of requestedUids) {
    const substitution = substitutions.get(templateUid) || null;
    if (!accepted.has(templateUid) && !substitution) {
      throw new CatalogRunIntegrationError(
        'template_not_in_selection',
        `Template is not accepted or substituted under the active selection: ${templateUid}`,
        { status: 422, details: [{ template_uid: templateUid }] },
      );
    }

    let template;
    let reference;
    try {
      template = await loadTemplate({ root, templateUid });
      reference = await resolveTemplateReference({ root, templateUid });
    } catch (error) {
      throw new CatalogRunIntegrationError('invalid_catalog_template_uid', `Catalog template could not be resolved: ${templateUid}`, {
        status: error?.code === 'ENOENT' ? 404 : 400,
        details: [{ template_uid: templateUid }],
        cause: error,
      });
    }

    const imageBytes = await readFile(reference.path);
    const referenceHash = sha256(imageBytes);
    if (referenceHash !== reference.sha256 || referenceHash !== template.reference_image?.sha256) {
      throw new CatalogRunIntegrationError('template_selection_link_failed', 'Catalog reference hash does not match immutable evidence', {
        details: [{ template_uid: templateUid, source_code: 'reference_hash_mismatch' }],
      });
    }

    const candidate = candidateEvidence(selection, templateUid);
    catalogReferences.push({
      source_type: 'catalog_template',
      decision_type: substitution ? 'substituted' : 'accepted',
      substituted_for_template_uid: substitution?.removed_template_uid || null,
      selection_source_kind: substitution?.source_kind || (accepted.has(templateUid) ? 'top4' : null),
      selection_source_slate_id: substitution?.source_slate_id || null,
      template_uid: template.template_uid,
      template_name: template.template_info.template_name,
      source_ordinal: template.source_ordinal,
      image_bytes: imageBytes,
      reference_image_sha256: referenceHash,
      reference_image_extension: template.reference_image.extension,
      reference_image_mime_type: template.reference_image.mime_type,
      generation_blueprint_sha256: sha256(stableJson(template.generation_blueprint)),
      selected_rank: candidate?.rank ?? null,
      relevance_score: candidate?.relevance_score ?? null,
      selection_id: selection.selection_id,
      catalog_projection_version: selection.catalog_projection_version,
      ranking_policy_version: selection.ranking_policy_version,
    });
  }

  return {
    catalogReferences,
    selection,
    selectionSnapshot: {
      selection_id: selection.selection_id,
      decision_id: decision.decision_id,
      ranking_policy_version: selection.ranking_policy_version,
      catalog_projection_version: selection.catalog_projection_version,
      catalog_content_sha256: selection.catalog_content_sha256,
      accepted_template_uids: requestedUids,
      link_state: 'pending',
    },
  };
}

export async function linkCatalogSelectionToRun({
  root,
  runId,
  selection,
  templateDecisionIdempotencyKey,
  selectionDecisionRecorder = recordTemplateSelectionDecision,
}) {
  if (!selection?.decision?.decision_id) {
    throw new CatalogRunIntegrationError('template_selection_link_failed', 'Template selection decision is unavailable for Run linkage');
  }
  const decisionIdempotencyKey = runLinkIdempotencyKey({
    selectionId: selection.selection_id,
    runId,
    decisionId: selection.decision.decision_id,
    baseKey: templateDecisionIdempotencyKey,
  });
  try {
    return await selectionDecisionRecorder({
      root,
      selectionId: selection.selection_id,
      decisionIdempotencyKey,
      decision: linkDecisionPayload(selection, runId),
    });
  } catch (error) {
    throw new CatalogRunIntegrationError('template_selection_link_failed', 'Template selection could not be linked safely', {
      status: error?.status || 409,
      details: [{ source_code: error?.code || 'selection_link_failed' }],
      cause: error,
    });
  }
}

export function assertTemplateSelectionLinked(runOrManifest) {
  const manifest = runOrManifest?.manifest || runOrManifest;
  const hasCatalogReference = Array.isArray(manifest?.template_references)
    && manifest.template_references.some((reference) => reference?.source_type === 'catalog_template');
  const hasCatalogSelection = Boolean(manifest?.template_selection);
  if (!hasCatalogReference && !hasCatalogSelection) return;
  if (manifest.template_selection?.link_state !== 'linked') {
    throw new CatalogRunIntegrationError(
      'template_selection_link_failed',
      'Run template selection must be linked before provider staging or submission',
      {
        status: 409,
        runId: manifest?.run_id || null,
        details: [{ link_state: manifest.template_selection?.link_state || 'missing' }],
      },
    );
  }
}

