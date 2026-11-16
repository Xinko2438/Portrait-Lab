import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const htmlUrl = new URL('../public/index.html', import.meta.url);
const cssUrl = new URL('../public/app.css', import.meta.url);
const appUrl = new URL('../public/app.js', import.meta.url);

test('image-first create screen shows only the choices needed to start and uses everyday language',async()=>{
  const html=await readFile(htmlUrl,'utf8');
  assert.match(html,/添加客户照片后即可开始；模板和补充要求可选/);
  assert.match(html,/一张清晰照片就可以/);
  assert.match(html,/更多设置（一般不用）/);
  assert.match(html,/id="prepareRun"[^>]*>开始生成</);
  assert.doesNotMatch(html,/选择任务意图|选择目标结果|专用生图提示词|人脸底线已启用|明确覆盖/);
  const advanced=html.slice(html.indexOf('id="moreTaskSettings"'),html.indexOf('class="customer-visual-status"'));
  for(const id of ['newCustomerFields','intendedUse','apiOperation','apiImageSize','apiImageQuality','apiMask','sendPromptPreviewDetails'])assert.match(advanced,new RegExp(`id="${id}"`));
  const main=html.slice(html.indexOf('<div class="task-brief-scroll">'),html.indexOf('<details class="advanced-reference-settings"'));
  for(const id of ['generationMode','userSupplement','apiImageCount'])assert.match(main,new RegExp(`id="${id}"`));
});

test('recommendation section exists in workbench task-brief with triggers and container', async () => {
  const [html, app] = await Promise.all([readFile(htmlUrl, 'utf8'), readFile(appUrl, 'utf8')]);
  assert.match(html, /id="requestRecommendationsButton"/, 'expected recommend trigger button');
  assert.match(html, /id="recommendationsContainer"/, 'expected recommendations results container');
  assert.match(html, /id="top4RecommendationsGrid"/, 'expected top4 container');
  assert.match(html, /id="safeInspirationSection"/, 'expected inspiration to remain separate from Top4');
  assert.match(html, /id="safeInspirationGrid"/, 'expected inspiration grid');
  assert.match(html, /id="refreshSafeInspirationButton"/, 'expected inspiration refresh control');
  assert.match(html, /id="top10RecommendationsDisclosure"/, 'expected top10 disclosure/details');
  assert.match(html, /id="toggleAllRecommendationsButton"/, 'expected expand-all action');
  assert.match(html, /id="recommendationStateNotice"/, 'expected recommendation status/notice element');

  const css = await readFile(cssUrl, 'utf8');
  assert.match(css, /.recommendations-section/, 'expected recommendation styles');
  assert.match(css, /.recommendation-card/, 'expected recommendation card styles');
  assert.match(css, /.recommendation-badge/, 'expected recommendation rank badge');
  assert.match(app, /handleRecommendationCardKeydown/);
  assert.match(app, /\['Enter',\s*' '\]/);
  for (const grid of ['top4RecommendationsGrid', 'top10RecommendationsGrid', 'safeInspirationGrid']) {
    assert.match(app, new RegExp(`${grid}\\?\\.addEventListener\\('keydown'`));
  }
});

test('recommendation controller emits exact real API contract and canonical task brief values', async () => {
  const libModule = await import('../public/template-library.js');
  const brief = libModule.mapFormToTaskBrief({
    customerName: '张三 客户',
    intendedUse: '直播封面',
    targetFraming: 'half_body',
    targetAngle: 'frontal',
    prompt: '专业干练，避免甜美',
  });
  assert.match(brief.customer_scope_id, /^cust_[a-f0-9]{16}$/);
  assert.notEqual(brief.customer_scope_id, '张三 客户');
  assert.deepEqual(brief.target_portrait_scales, ['half_body']);
  assert.deepEqual(brief.target_face_angles, ['front']);
  assert.equal('target_scales' in brief, false);
  assert.equal(brief.max_identity_preservation_risk, 'medium');
  assert.equal(brief.allow_text_on_face, false);
  assert.deepEqual(brief.required_face_visibility, ['high', 'medium']);

  const selection = {
    selection_id: 'selection_12345',
    status: 'ready',
    top4: [
      { template_uid: 'tpl_001', rank: 1, relevance_score: 92 },
      { template_uid: 'tpl_002', rank: 2, relevance_score: 88 },
    ],
    top10: [
      { template_uid: 'tpl_001', rank: 1, relevance_score: 92 },
      { template_uid: 'tpl_002', rank: 2, relevance_score: 88 },
      { template_uid: 'tpl_003', rank: 3, relevance_score: 80 },
    ],
    ranked_candidates: [
      { template_uid: 'tpl_001', rank: 1, relevance_score: 92 },
      { template_uid: 'tpl_002', rank: 2, relevance_score: 88 },
      { template_uid: 'tpl_003', rank: 3, relevance_score: 80 },
      { template_uid: 'tpl_004', rank: 4, relevance_score: 77 },
    ],
    filter_summary: { catalog_total: 124, eligible_count: 18, rejected_count: 106, rejection_counts: { identity_risk_excluded: 5 } },
    warnings: [],
  };
  let selectionRequest = null;
  let decisionRequest = null;
  const fakeFetch = async (url, options) => {
    if (url === '/api/template-selections') {
      selectionRequest = JSON.parse(options.body);
      return { ok: true, json: async () => ({ selection, idempotent_replay: false }) };
    }
    if (url === '/api/template-selections/selection_12345/decisions') {
      decisionRequest = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          selection: { ...selection, status: 'decision_recorded', decision: { decision_id: 'decision_01', ...decisionRequest } },
          idempotent_replay: false,
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }) };
  };

  const controller = libModule.createRecommendationController({
    fetch: fakeFetch,
    selectionIdempotencyKeyFactory: () => 'selection-ui-contract-01',
    decisionIdempotencyKeyFactory: () => 'decision-ui-contract-01',
  });
  const created = await controller.requestRecommendations(brief);
  assert.deepEqual(selectionRequest, { idempotency_key: 'selection-ui-contract-01', task_brief: brief });
  assert.equal(created.selection.selection_id, 'selection_12345');
  assert.equal(controller.getSelectionId(), 'selection_12345');
  assert.equal(controller.getTop4().length, 2);
  assert.equal(controller.getTop10().length, 3);
  assert.deepEqual(controller.getAlternatives().map((item) => item.template_uid), ['tpl_003', 'tpl_004']);
  assert.deepEqual(controller.getAlternatives({ expanded: true }).map((item) => item.template_uid), ['tpl_003', 'tpl_004']);
  assert.equal(controller.getRejectionSummary().identity_risk_excluded, 5);
  assert.equal(controller.matchesTaskBrief(brief), true);
  assert.equal(controller.matchesTaskBrief({ ...brief, use_case: 'company_profile' }), false);

  const decision = {
    actor: 'primary-user',
    accepted_template_uids: ['tpl_001'],
    removed_template_uids: ['tpl_002'],
    substitutions: [],
    linked_run_ids: [],
    notes: '',
  };
  const recorded = await controller.recordDecision(decision);
  assert.deepEqual(decisionRequest, { decision_idempotency_key: 'decision-ui-contract-01', ...decision });
  assert.equal(recorded.selection.decision.decision_id, 'decision_01');
  assert.equal(controller.getDecisionIdempotencyKey(), 'decision-ui-contract-01');
});

test('active recommendations are bound to the exact current task brief and stale form state is invalidated', async () => {
  const libModule = await import('../public/template-library.js');
  const app = await readFile(appUrl, 'utf8');
  const firstBrief = libModule.mapFormToTaskBrief({
    customerScopeId: 'cust_1111111111111111',
    intendedUse: 'professional_portrait',
    targetFraming: 'half_body',
    targetAngle: 'left_45',
    temperamentKeywords: ['professional', 'calm'],
    prompt: '稳重',
  });
  let fetchCount = 0;
  const controller = libModule.createRecommendationController({
    fetch: async (_url, options) => {
      fetchCount += 1;
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ selection: { selection_id: 'sel_222222222222222222222222', task_brief: body.task_brief, top4: [], top10: [] } }) };
    },
    selectionIdempotencyKeyFactory: () => 'selection-task-binding',
  });
  await controller.requestRecommendations(firstBrief);
  assert.equal(controller.matchesTaskBrief(firstBrief), true);
  assert.equal(controller.matchesTaskBrief({ ...firstBrief, customer_scope_id: 'cust_2222222222222222' }), false);
  assert.equal(controller.matchesTaskBrief({ ...firstBrief, target_face_angles: ['front'] }), false);
  assert.equal(controller.matchesTaskBrief({ ...firstBrief, temperament_keywords: ['approachable'] }), false);
  controller.clearSelectionState();
  assert.equal(controller.getSelection(), null);
  assert.equal(fetchCount, 1);

  assert.match(app, /customerScopeId/);
  assert.match(app, /get\('targetIntentAngle'\)/);
  assert.match(app, /getAll\('temperamentKeywords'\)/);
  assert.match(app, /invalidateRecommendationIfTaskChanged/);
  assert.match(app, /matchesTaskBrief/);
  assert.match(app, /旧推荐已失效/);
  assert.match(app, /推荐计算期间发生变化，旧结果已丢弃/);
});

test('alternative recommendations exclude Top4, default to ten, expand to every remaining eligible template, and support legacy fallback', async () => {
  const libModule = await import('../public/template-library.js');
  const ranked = Array.from({ length: 16 }, (_, index) => ({ template_uid: `tpl_${index + 1}`, rank: index + 1 }));
  const selection = { top4: [ranked[0], ranked[2], ranked[4], ranked[6]], top10: ranked.slice(0, 10), ranked_candidates: ranked };
  assert.deepEqual(libModule.recommendationAlternatives(selection).map((item) => item.template_uid), ['tpl_2', 'tpl_4', 'tpl_6', 'tpl_8', 'tpl_9', 'tpl_10', 'tpl_11', 'tpl_12', 'tpl_13', 'tpl_14']);
  assert.deepEqual(libModule.recommendationAlternatives(selection, { expanded: true }).map((item) => item.template_uid), ['tpl_2', 'tpl_4', 'tpl_6', 'tpl_8', 'tpl_9', 'tpl_10', 'tpl_11', 'tpl_12', 'tpl_13', 'tpl_14', 'tpl_15', 'tpl_16']);
  assert.deepEqual(libModule.recommendationAlternatives({ top4: [ranked[0]], top10: ranked.slice(0, 3) }).map((item) => item.template_uid), ['tpl_2', 'tpl_3']);
});

test('recommendation controller requests safe inspiration separately without changing Top4', async () => {
  const libModule = await import('../public/template-library.js');
  const selection = {
    selection_id: 'sel_111111111111111111111111',
    top4: [{ template_uid: 'tpl_top', rank: 1 }],
    top10: [{ template_uid: 'tpl_top', rank: 1 }],
    ranked_candidates: [{ template_uid: 'tpl_top', rank: 1 }],
  };
  const originalTop4 = structuredClone(selection.top4);
  let request = null;
  const controller = libModule.createRecommendationController({
    fetch: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 201,
        json: async () => ({
          slate_id: 'slate_111111111111111111111111',
          policy_version: 'template-exploration-v1',
          cycle_index: 0,
          round_index: 0,
          candidates: [{ template_uid: 'tpl_inspiration', rank: 5, relevance_score: 77 }],
          idempotent_replay: false,
        }),
      };
    },
    explorationIdempotencyKeyFactory: () => 'ui-exploration-key',
  });
  controller.setSelectionState(selection);
  const result = await controller.requestSafeInspiration();
  assert.deepEqual(request, {
    url: `/api/template-selections/${selection.selection_id}/explorations`,
    body: { exploration_idempotency_key: 'ui-exploration-key' },
  });
  assert.equal(result.slate_id, 'slate_111111111111111111111111');
  assert.deepEqual(controller.getSafeInspiration(), result);
  assert.deepEqual(controller.getTop4(), originalTop4);
});

test('safe-inspiration network retry reuses the uncertain idempotency key and returns the same slate', async () => {
  const libModule = await import('../public/template-library.js');
  const selection = {
    selection_id: 'sel_333333333333333333333333',
    task_brief: libModule.mapFormToTaskBrief({ customerScopeId: 'cust_3333333333333333', intendedUse: 'professional_portrait' }),
    top4: [{ template_uid: 'tpl_top', rank: 1 }],
    top10: [{ template_uid: 'tpl_top', rank: 1 }],
  };
  const bodies = [];
  let callCount = 0;
  let keyCount = 0;
  const controller = libModule.createRecommendationController({
    fetch: async (_url, options) => {
      callCount += 1;
      bodies.push(JSON.parse(options.body));
      if (callCount === 1) throw new Error('network disconnected after request');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          slate_id: 'slate_333333333333333333333333',
          candidates: [{ template_uid: 'tpl_safe', rank: 5 }],
          idempotent_replay: true,
        }),
      };
    },
    explorationIdempotencyKeyFactory: () => `retry-key-${++keyCount}`,
  });
  controller.setSelectionState(selection);

  await assert.rejects(() => controller.requestSafeInspiration(), /network disconnected/);
  const replay = await controller.requestSafeInspiration();

  assert.equal(keyCount, 1);
  assert.deepEqual(bodies, [
    { exploration_idempotency_key: 'retry-key-1' },
    { exploration_idempotency_key: 'retry-key-1' },
  ]);
  assert.equal(replay.slate_id, 'slate_333333333333333333333333');
});
