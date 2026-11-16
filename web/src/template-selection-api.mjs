import {
  TemplateSelectionError,
  createTemplateSelection,
  loadTemplateSelection,
  recordTemplateExploration,
  recordTemplateSelectionDecision,
} from './template-selection.mjs';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function respondJson(res, status, value) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(value));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) {
        throw new TemplateSelectionError('invalid_json', 'JSON request body is too large');
      }
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TemplateSelectionError('invalid_json', 'JSON request body must be an object');
    }
    return value;
  } catch (error) {
    if (error instanceof TemplateSelectionError) throw error;
    if (error instanceof SyntaxError) {
      throw new TemplateSelectionError('invalid_json', 'Malformed JSON request body');
    }
    throw error;
  }
}

function publicError(error) {
  if (error instanceof TemplateSelectionError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          details: Array.isArray(error.details) ? error.details : [],
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'internal_error',
        message: 'Template selection request failed',
        details: [],
      },
    },
  };
}

export function createTemplateSelectionApiHandler({ root }) {
  if (!root) throw new TypeError('root is required');

  return async function handleTemplateSelectionRequest(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const selectionRoute = url.pathname.match(/^\/api\/template-selections\/([^/]+)$/);
    const decisionRoute = url.pathname.match(/^\/api\/template-selections\/([^/]+)\/decisions$/);
    const explorationRoute = url.pathname.match(/^\/api\/template-selections\/([^/]+)\/explorations$/);
    const isCreateRoute = url.pathname === '/api/template-selections';

    if (!isCreateRoute && !selectionRoute && !decisionRoute && !explorationRoute) return false;

    try {
      if (req.method === 'POST' && isCreateRoute) {
        const body = await readJsonBody(req);
        const result = await createTemplateSelection({
          root,
          idempotencyKey: body.idempotency_key,
          taskBrief: body.task_brief,
        });
        respondJson(res, result.idempotent_replay ? 200 : 201, result);
        return true;
      }

      if (req.method === 'GET' && selectionRoute) {
        const selection = await loadTemplateSelection({ root, selectionId: selectionRoute[1] });
        respondJson(res, 200, { selection });
        return true;
      }

      if (req.method === 'POST' && decisionRoute) {
        const body = await readJsonBody(req);
        const result = await recordTemplateSelectionDecision({
          root,
          selectionId: decisionRoute[1],
          decisionIdempotencyKey: body.decision_idempotency_key,
          decision: {
            actor: body.actor,
            accepted_template_uids: body.accepted_template_uids,
            removed_template_uids: body.removed_template_uids,
            substitutions: body.substitutions,
            linked_run_ids: body.linked_run_ids,
            notes: body.notes,
          },
        });
        respondJson(res, 200, result);
        return true;
      }

      if (req.method === 'POST' && explorationRoute) {
        const body = await readJsonBody(req);
        const allowed = new Set(['exploration_idempotency_key']);
        const forbidden = Object.keys(body).find((key) => !allowed.has(key));
        if (forbidden) {
          throw new TemplateSelectionError(
            forbidden.toLowerCase().includes('candidate') || forbidden.toLowerCase().includes('template')
              ? 'caller_candidates_forbidden'
              : 'invalid_exploration_request',
            'Safe inspiration candidates are selected only from stored server evidence',
          );
        }
        const result = await recordTemplateExploration({
          root,
          selectionId: explorationRoute[1],
          explorationIdempotencyKey: body.exploration_idempotency_key,
        });
        const rankedByUid = new Map([
          ...(result.selection.ranked_candidates || []),
          ...(result.selection.top10 || []),
        ].map((item) => [item.template_uid, item]));
        respondJson(res, result.idempotent_replay ? 200 : 201, {
          ...result.slate,
          candidates: result.slate.candidates.map((candidate) => ({
            ...(rankedByUid.get(candidate.template_uid) || {}),
            ...candidate,
          })),
          idempotent_replay: result.idempotent_replay,
        });
        return true;
      }

      respondJson(res, 405, {
        error: {
          code: 'method_not_allowed',
          message: 'Method not allowed for template selection route',
          details: [],
        },
      });
      return true;
    } catch (error) {
      const response = publicError(error);
      respondJson(res, response.status, response.body);
      return true;
    }
  };
}
