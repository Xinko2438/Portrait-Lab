function clone(value) { return globalThis.structuredClone ? globalThis.structuredClone(value) : JSON.parse(JSON.stringify(value)); }

export function createTemplateStyleDraft({ projection = null } = {}) {
  const confirmation = projection?.confirmation || null;
  const suggestion = projection?.suggestion || null;
  return {
    primaryStyle: confirmation?.tag?.primary_style || suggestion?.tag?.primary_style || '',
    confirmed: Boolean(confirmation),
    suggested: !confirmation && Boolean(suggestion),
    suggestionEventId: suggestion?.event_id || null,
    supersedesEventId: confirmation?.event_id || null,
    dirty: false,
  };
}

export function updateTemplateStyleDraft(draft, primaryStyle) { return { ...clone(draft), primaryStyle: String(primaryStyle || ''), dirty: true }; }

export function buildTemplateStyleConfirmationPayload({ draft, imageSha256, idempotencyKey }) {
  if (!draft?.primaryStyle) throw new Error('Template primary style is required');
  return { kind: 'confirmation', image_sha256: String(imageSha256 || ''), idempotency_key: String(idempotencyKey || ''), actor: 'primary-user', supersedes_event_id: draft.supersedesEventId || null, tag: { primary_style: draft.primaryStyle } };
}

