import { createHash } from 'node:crypto';

const text = value => typeof value === 'string' && value.length ? value : null;
const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const digest = value => value === null ? null : createHash('sha256').update(value, 'utf8').digest('hex');
const filename = value => text(value)?.split(/[\\/]/).pop() || null;
const enc = value => encodeURIComponent(String(value));

function providerName(value) {
  if (!text(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return `${url.origin}${url.pathname}`.replace(/\/$/, '');
  } catch {
    return /^[\w .-]{1,100}$/.test(value) ? value : null;
  }
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function referenceUrl(runId, kind, ordinal) {
  return runId && ['identity', 'template'].includes(kind) && ordinal !== null
    ? `/api/runs/${enc(runId)}/references/${kind}/${ordinal}/file` : null;
}

function revisionReferences(manifest) {
  const source = manifest.revision_source || {};
  const parentRun = source.parent_run_id || manifest.parent_run_id;
  const parentArtifact = source.parent_artifact_id || manifest.parent_artifact_id;
  const artifactUrl = parentRun && parentArtifact ? `/api/runs/${enc(parentRun)}/artifacts/${enc(parentArtifact)}/file` : null;
  return (manifest.revision_request?.input_roles || ['clean_original', 'annotated_location_guidance']).map((role, index) => ({
    role, ordinal: index + 1,
    name: role === 'clean_original' ? 'original.png' : 'annotated-preview.png',
    sha256: role === 'clean_original' ? source.original_sha256 || source.parent_artifact_sha256 || null : source.annotated_preview_sha256 || null,
    url: role === 'clean_original' ? artifactUrl : null,
  }));
}

function referencesFor(run, orderedReferences) {
  const manifest = run.manifest || {};
  const runId = run.runId || manifest.run_id;
  const grouped = [
    ...(manifest.identity_references || []).map((ref, index) => ({ ...ref, kind: 'identity', collection_index: index, ordinal: ref.ordinal ?? index + 1 })),
    ...(manifest.template_references || []).map((ref, index) => ({ ...ref, kind: 'template', collection_index: index, ordinal: ref.ordinal ?? index + 1 })),
  ];
  if (orderedReferences === undefined && !grouped.length && manifest.revision_source) return revisionReferences(manifest);
  return (orderedReferences ?? grouped).map((ref, index) => {
    const explicitKind = ['identity', 'template'].includes(ref.kind) ? ref.kind
      : ['identity', 'template'].includes(ref.role) ? ref.role : null;
    const candidates = grouped.filter(item => (!explicitKind || item.kind === explicitKind)
      && (!ref.sha256 || item.sha256 === ref.sha256));
    let matches;
    if (explicitKind && ref.collection_index !== undefined) {
      matches = candidates.filter(item => item.collection_index === Number(ref.collection_index));
    } else if (explicitKind && ref.ordinal !== undefined) {
      matches = candidates.filter(item => item.ordinal === Number(ref.ordinal));
    } else if (ref.role && ref.ordinal !== undefined) {
      matches = candidates.filter(item => item.role === ref.role && item.ordinal === Number(ref.ordinal));
    } else {
      matches = ref.sha256 ? candidates : [];
    }
    const match = matches.length === 1 ? matches[0] : null;
    const kind = explicitKind || match?.kind;
    const ordinal = number(ref.ordinal ?? match?.ordinal ?? index + 1);
    return {
      role: text(ref.role) || kind || null,
      ordinal,
      name: filename(ref.name || ref.original_name || ref.original_filename || ref.filename || match?.original_name || match?.original_filename || match?.filename),
      sha256: text(ref.sha256) || (ref.bytes instanceof Uint8Array ? createHash('sha256').update(ref.bytes).digest('hex') : null),
      url: match ? referenceUrl(runId, kind, match.collection_index) : null,
    };
  });
}

/** Allowlisted, detached send-time evidence. The caller supplies the exact transport prompt. */
export function buildSubmissionSnapshot(run, options = {}) {
  const manifest = run.manifest || {};
  const api = manifest.image_api || {};
  const channel = options.channel === 'api' || options.channel === 'web' ? options.channel : manifest.image_api ? 'api' : 'web';
  const prompt = text(options.prompt);
  return freeze({
    schema_version: 'ai-img-gen.request-snapshot.v1',
    ...(manifest.preparation_revision_id?{preparation_revision_id:manifest.preparation_revision_id}:{}),
    channel,
    model: text(options.model ?? (channel === 'api' ? api.model : null)),
    provider: providerName(options.provider ?? (channel === 'api' ? api.provider : null)),
    operation: text(options.operation ?? api.operation),
    requested_count: number(options.requestedCount ?? api.n ?? manifest.revision_request?.requested_count ?? manifest.candidate_slate_request?.requested_count),
    size: text(options.size ?? api.size),
    quality: text(options.quality ?? api.quality),
    prompt,
    prompt_sha256: digest(prompt),
    references: referencesFor(run, options.orderedReferences),
  });
}

function legacyPrompt(run) {
  const events = run.events || [];
  const submittedIndex = events.findIndex(event => event.type === 'RunSubmitted');
  if (submittedIndex === -1) return { prompt: null, source: null };
  const submittedTime = Date.parse(events[submittedIndex].recorded_at);
  const edits = events.map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'RunRecordUpdated' && typeof event.data?.prompt_text === 'string');
  // The confirmed submission bounds the entire send window, including racing edits.
  const conflict = edits.some(({ event, index }) => {
    const editedTime = Date.parse(event.recorded_at);
    return index < submittedIndex || !Number.isFinite(submittedTime) || !Number.isFinite(editedTime) || editedTime <= submittedTime;
  });
  if (conflict) return { prompt: null, source: null };
  const manifest = run.manifest || {};
  const isApi = Boolean(manifest.image_api);
  const isVerbatimRevision = manifest.schema_version === 'ai-img-gen.artifact-revision-run.v1'
    && manifest.run_kind === 'artifact_revision';
  const isCompiledWeb = ['ai-img-gen.web-run.v6', 'ai-img-gen.web-run.v7'].includes(manifest.schema_version);
  const compiled = text(manifest.prompt_compilation?.compiled_prompt);
  if (compiled && (isApi || (!isVerbatimRevision && isCompiledWeb))) {
    const prompt = isApi ? compiled : text(compiled.trim());
    if (prompt) return { prompt, source: 'prompt_compilation' };
  }
  // Earlier normal web transports wrapped prompt.txt in extra instructions. Its
  // contents cannot stand in for the complete historical request text.
  const original = isApi || isVerbatimRevision ? text(text(run.originalPrompt)?.trim()) : null;
  return { prompt: original, source: original ? 'prompt.txt' : null };
}

/** Read projection only: edited record text is never evidence of what was sent. */
export function buildGenerationDetails(run) {
  const manifest = run.manifest || {};
  const events = run.events || [];
  const firstAttempt = events.find(event => event.type === 'RunSubmissionAttemptStarted');
  const snapshot = firstAttempt?.data?.request_snapshot;
  const submitted = events.find(event => event.type === 'RunSubmitted');
  const legacy = snapshot ? null : legacyPrompt(run);
  const prompt = snapshot ? text(snapshot.prompt) : legacy.prompt;
  const source = snapshot ? 'request_snapshot' : legacy.source;
  const status = prompt === null ? 'unknown' : snapshot ? 'recorded' : 'reconstructed';
  const channel = snapshot ? (['api', 'web'].includes(snapshot.channel) ? snapshot.channel : null)
    : manifest.image_api ? 'api' : (firstAttempt || submitted) ? 'web' : null;
  const api = manifest.image_api || {};
  const known = snapshot || api;
  const lineage = manifest.revision_source || {};
  const references = snapshot && Array.isArray(snapshot.references)
    ? snapshot.references.map(ref => ({
      role: text(ref.role), ordinal: number(ref.ordinal), name: filename(ref.name), sha256: text(ref.sha256),
      url: typeof ref.url === 'string' && /^\/api\/runs\/[^/]+\/(?:references\/(?:identity|template)\/\d+|artifacts\/[^/]+)\/file$/.test(ref.url) ? ref.url : null,
    })) : referencesFor(run);
  return {
    channel,
    channel_label: channel === 'api' ? 'API 生图' : channel === 'web' ? 'ChatGPT 网页生图' : '未知',
    model: text(known.model),
    provider: providerName(known.provider),
    operation: text(known.operation),
    requested_count: snapshot ? number(snapshot.requested_count) : number(api.n ?? (channel ? manifest.revision_request?.requested_count ?? manifest.candidate_slate_request?.requested_count : null)),
    returned_count: Array.isArray(manifest.artifacts) ? manifest.artifacts.length : 0,
    size: text(known.size), quality: text(known.quality),
    elapsed_ms: number(submitted?.data?.elapsed_ms),
    prompt,
    prompt_evidence: {
      status, source: prompt === null ? null : source,
      label: status === 'recorded' ? '发送时记录的请求快照' : status === 'reconstructed' ? `根据原始${source === 'prompt_compilation' ? '编译提示词' : '提示词文件'}和发送事件还原` : '未记录可确认的实际发送提示词',
    },
    prompt_sha256: digest(prompt), references,
    source_run_id: text(manifest.source_run_id),
    parent_run_id: text(lineage.parent_run_id || manifest.parent_run_id),
    parent_artifact_id: text(lineage.parent_artifact_id || manifest.parent_artifact_id),
  };
}
