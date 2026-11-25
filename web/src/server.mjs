import http from 'node:http';
import { createImageApiHandler } from './image-api.mjs';
import { createImageApiService, imageApiConfig } from './image-api.mjs';
import { buildGenerationDetails, buildSubmissionSnapshot } from './generation-details.mjs';
import { buildReuseDescriptor, materializeReusedReferences, runCustomerId } from './reference-reuse.mjs';
import { prepareApiArtifactRevision } from './api-artifact-revision.mjs';
import { buildGenerationPrompt } from './chatgpt-executor.mjs';
import { createCustomerVisualService } from './customer-visual-analysis.mjs';
import { smartInputsFromForm, smartManualFromForm, resolveSmartSubmission, assertSmartReady } from './smart-task-resolution.mjs';
import { reviseRunPreparation } from './run-store.mjs';
import { resolveCatalogSelectionForRun } from './catalog-run-integration.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  beginRunSubmissionAttempt,
  createHistoricalRun,
  createRunSnapshot,
  importArtifacts,
  discardSavedRun,
  listRuns,
  loadArtifactAnnotation,
  loadRun,
  recordRunEvent,
  saveArtifactAnnotation,
  saveArtifactReview,
  saveAestheticComparison,
  savePreference,
  saveResultFiles,
  saveReview,
  updateRunRecord,
} from './run-store.mjs';
import { assertTemplateSelectionLinked, CatalogRunIntegrationError } from './catalog-run-integration.mjs';
import { assertTemplatesNotRejected } from './face-tag-store.mjs';
import { probeBrowser } from './playwright-bridge.mjs';
import { ensureMcpServer, isPortOpen } from './mcp-process.mjs';
import { McpClient } from './mcp-client.mjs';
import { ChatGptExecutor } from './chatgpt-executor.mjs';
import { captureRunArtifacts, ChatGptMcpResultCapture } from './result-capture.mjs';
import { resolveRunReferenceFile } from './reference-files.mjs';
import { resolveAnnotationPreview } from './annotation-store.mjs';
import { listTemplates, loadTemplate, resolveTemplateReference } from './template-catalog.mjs';
import { createTemplateSelectionApiHandler } from './template-selection-api.mjs';
import { normalizeTaskIntent } from './intelligent-workbench/intent-schema.mjs';
import { createFoundationProviderRegistry, inspectOpenCodexHealth } from './intelligent-workbench/ai-provider.mjs';
import { appendIdentitySet, createIdentitySet, listCustomers, listIdentitySets, materializeIdentitySet, removeIdentityReference, renameIdentityReference } from './customer-identity-store.mjs';
import { selectCustomerIdentityFiles } from './customer-photo-selection.mjs';
import { buildIdentityDedupPlan } from './customer-identity-governance.mjs';
import {
  invalidateTemplateSelectionOutcome,
  loadTemplateSelection,
  normalizeTaskBrief,
  recordTemplateSelectionOutcome,
} from './template-selection.mjs';
import { createCompoundingService } from './intelligent-workbench/compounding-service.mjs';
import { loadReviewerCalibrationProjection } from './intelligent-workbench/reviewer-calibration-store.mjs';
import { REVIEW_RUBRIC } from './rubric.mjs';
import { buildCandidateSlateRequest } from './intelligent-workbench/candidate-slate.mjs';
import { createAiPromptWriter } from './intelligent-workbench/ai-prompt-writer.mjs';
import { createCaptureAutomation } from './capture-automation.mjs';
import { resolveServerConfiguration } from './server-config.mjs';
import { preparePromptCompilation } from './intelligent-workbench/prompt-recipe-runtime.mjs';
import { buildPromptRecipePreview } from './intelligent-workbench/prompt-recipe.mjs';
import { parseFaceAngleSubmission } from './face-angle-evidence.mjs';
import { createFaceTagApiHandler } from './face-tag-api.mjs';
import { createTemplateStyleApiHandler } from './template-style-api.mjs';
import { createTemplateStyleFacetsV2ApiHandler } from './template-style-facets-v2-api.mjs';
import { createArtifactRevisionRun, isArtifactRevisionRun } from './artifact-revision-store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(here, '..', '..');
const serverConfiguration = resolveServerConfiguration({ sourceRoot });
const projectRoot = serverConfiguration.projectRoot;
const promptRecipeEnabled = serverConfiguration.promptRecipeEnabled;
const publicRoot = join(sourceRoot, 'web', 'public');
const tutorialRoot = join(sourceRoot, 'knowledge', 'tutorials', 'portrait-reference-selection-and-aesthetic-rubric', 'distilled');
const runtimeRoot = join(projectRoot, '.runtime');
const fabricModulePath = join(here, '..', 'node_modules', 'fabric', 'dist', 'index.min.mjs');
const port = Number(process.env.AI_IMG_GEN_PORT || 4577);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
};

function customerScopeIdFromName(value) {
  let hash = 0xcbf29ce484222325n;
  const normalized = String(value || '').trim().replace(/\s+/g, ' ').normalize('NFKC').toLowerCase() || 'anonymous-customer';
  for (const byte of new TextEncoder().encode(normalized)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `cust_${hash.toString(16).padStart(16, '0')}`;
}

function templateTaskBriefFromRunForm(form, customerId) {
  const scaleMap = {
    headshot: 'close_up', close_up: 'close_up', bust: 'bust', half_body: 'half_body',
    three_quarter: 'half_body', full_body: 'full_body', environmental_portrait: 'environmental_portrait',
  };
  const angleMap = {
    frontal: 'front', front: 'front', front_15_degree: 'front_15_degree', front_30_degree: 'front_30_degree',
    left_45: 'side_45_degree', right_45: 'side_45_degree', side_45_degree: 'side_45_degree',
    profile: 'extreme_side', full_profile: 'extreme_side', extreme_side: 'extreme_side',
  };
  const intendedUse = String(form.get('intendedUse') || '').trim();
  const businessDomain = String(form.get('businessDomain') || '').trim();
  const supplement = String(form.get('userSupplement') || '').trim();
  const framing = scaleMap[String(form.get('targetFraming') || '').trim()] || '';
  const angle = angleMap[String(form.get('targetIntentAngle') || form.get('targetAngle') || '').trim()] || '';
  return normalizeTaskBrief({
    schema_version: 'ai-img-gen.customer-task-brief.v1',
    customer_scope_id: customerId || customerScopeIdFromName(form.get('customerName')),
    parent_selection_id: null,
    use_case: intendedUse.toLowerCase(),
    style_keywords: [],
    avoid_keywords: [],
    target_portrait_scales: framing ? [framing] : [],
    target_face_angles: angle ? [angle] : [],
    temperament_keywords: form.getAll('temperamentKeywords').map(String),
    face_feature_observations: [],
    required_face_visibility: ['high', 'medium'],
    allow_text_on_face: false,
    max_identity_preservation_risk: 'medium',
    max_generation_difficulty: 'high',
    diversity_preference: 'balanced',
    free_text_intent: [intendedUse, businessDomain, supplement].filter(Boolean).join(' '),
  });
}
const contentSecurityPolicy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' blob:; worker-src 'self' blob:; font-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

let mcpState = { ready: false, owned: false, process: null, state: 'not_started' };
let browserState = {
  ready: false,
  state: 'not_checked',
  message: '尚未主动检查。点击“重新检查”后才连接默认 Chrome。',
};
const executor = new ChatGptExecutor({ clientFactory: () => new McpClient(), canSelectBackgroundTab:()=>mcpState.owned===true&&mcpState.background===true });
const resultCapture = new ChatGptMcpResultCapture({ outputDir: join(runtimeRoot, 'playwright-mcp') });
const templateSelectionApi = createTemplateSelectionApiHandler({ root: projectRoot });
const faceTagApi = createFaceTagApiHandler({ root: projectRoot });
const templateStyleApi = createTemplateStyleApiHandler({ root: projectRoot });
const templateStyleFacetsV2Api = createTemplateStyleFacetsV2ApiHandler({ root: projectRoot });
const foundationProviders = createFoundationProviderRegistry();
const aiPromptWriter = process.env.AI_IMG_GEN_AI_PROMPT_WRITER_ENABLED === 'true' ? createAiPromptWriter() : null;
const compounding = createCompoundingService({
  root: projectRoot,
  loadRun,
  listRuns,
  recordRunEvent,
  recordOutcome: recordTemplateSelectionOutcome,
  invalidateOutcome: invalidateTemplateSelectionOutcome,
  loadSelection: loadTemplateSelection,
  loadReviewerCalibration: ({ root }) => loadReviewerCalibrationProjection({ root, rubricVersion: REVIEW_RUBRIC.rubric_version }),
});
const captureAutomation = createCaptureAutomation({
  capture: async (runId) => {
    const captured = await captureRunArtifacts({ root: projectRoot, runId, adapter: resultCapture, client: executor.clientForCapture(runId) });
    if (captured.manifest.artifacts.length) executor.releaseRun(runId);
    return captured;
  },
  listRuns: async () => (await listRuns({ root: projectRoot, includeExcluded: true, artifactsOnly: false, limit: 500 })).filter(run => !run.image_api),
});

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function formFiles(form, key) {
  const values = form.getAll(key);
  return Promise.all(values
    .filter((value) => value && typeof value.arrayBuffer === 'function' && value.size)
    .map(async (value) => ({ name: value.name, bytes: Buffer.from(await value.arrayBuffer()) })));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function attachMcpLifecycle(state) {
  if (!state.owned || !state.process || state.process.__aiImgGenAttached) return;
  state.process.__aiImgGenAttached = true;
  const stop = () => {
    if (state.process.exitCode === null) state.process.kill();
  };
  process.once('exit', stop);
  process.once('SIGINT', () => { stop(); process.exit(0); });
  process.once('SIGTERM', () => { stop(); process.exit(0); });
}

async function ensurePlaywright() {
  if (!(await isPortOpen())) {
    mcpState = await ensureMcpServer({
      tokenFile: join(runtimeRoot, 'playwright-extension-token'),
      outputDir: join(runtimeRoot, 'playwright-mcp'),
      logFile: join(runtimeRoot, 'playwright-mcp.log'),
      workingDirectory: projectRoot,
    });
    attachMcpLifecycle(mcpState);
  } else if (!mcpState.ready) {
    mcpState = { ready: true, owned: false, process: null };
  }
  // Only our verified background launch can safely reopen/select task pages.
  resultCapture.allowTabRecovery = mcpState.owned === true && mcpState.background === true;
  return mcpState;
}

async function publicRun(run) {
  let source=run;const visited=new Set();
  while(source.manifest.run_kind==='artifact_revision' && source.manifest.parent_run_id && visited.size<20){
    if(visited.has(source.runId))break;visited.add(source.runId);
    const parent=await loadRun({root:projectRoot,runId:source.manifest.parent_run_id});
    if(runCustomerId(parent.manifest)!==runCustomerId(run.manifest))break;source=parent;
  }
  return {
    runId: run.runId,
    prompt: run.prompt,
    manifest: run.manifest,
    generation_details: buildGenerationDetails(run),
    reuse: {...buildReuseDescriptor(source),via_revision:source.runId!==run.runId},
    current_api_config: await imageApiConfig(projectRoot),
    capabilities: {api_revision:Boolean(run.manifest.image_api && run.manifest.artifacts?.length)},
    events: run.events.map(({ event_id, type, recorded_at, data }) => ({ event_id, type, recorded_at, data })),
  };
}

await ensurePlaywright();

const imageApiHandler = createImageApiHandler({ root: projectRoot });
const imageApiRevisionService = createImageApiService({ root: projectRoot });
const customerVisualService = createCustomerVisualService({root:projectRoot,defaultEnabled:process.env.AI_IMG_GEN_AI_PROMPT_WRITER_ENABLED==='true'});
async function smartForm(req){
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>110*1024*1024)throw Object.assign(new Error('本次图片总量超过限制'),{status:413});chunks.push(chunk);}
  return new Request('http://localhost',{method:'POST',headers:{'content-type':req.headers['content-type']},body:Buffer.concat(chunks)}).formData();
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const smartRoute=url.pathname==='/api/task-resolutions'||url.pathname.startsWith('/api/customer-visual-analysis');
    const preparationRoute=url.pathname.match(/^\/api\/runs\/(run-[a-zA-Z0-9-]+)\/prepare$/);
    if((smartRoute||preparationRoute)&&req.method==='POST'&&(req.headers['x-smart-task-client']!=='workstation'||(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)))return json(res,403,{error:'仅允许工作台同源操作'});
    if(url.pathname==='/api/customer-visual-analysis/config'){
      if(req.method==='GET')return json(res,200,await customerVisualService.publicConfig());
      if(req.method==='POST')return json(res,200,await customerVisualService.saveConfig(await readJson(req)));
    }
    const visualStatus=url.pathname.match(/^\/api\/customer-visual-analysis\/(cust_[a-f0-9]{16})\/([a-f0-9]{64})$/);
    if(visualStatus&&req.method==='GET')return json(res,200,await customerVisualService.status({customerId:visualStatus[1],imageSha256:visualStatus[2]}));
    if(req.method==='POST'&&(url.pathname==='/api/task-resolutions'||url.pathname==='/api/customer-visual-analysis'||preparationRoute)){
      const form=await smartForm(req);const input=await smartInputsFromForm({root:projectRoot,form});
      if(url.pathname==='/api/customer-visual-analysis'){
        const entries=[];for(const file of input.identityFiles)entries.push(await customerVisualService.analyze({customerId:input.customerId,bytes:file.bytes,identitySetId:input.identitySetId,reanalyze:form.get('reanalyze')==='true',idempotencyKey:form.get('analysisIdempotencyKey')?`${form.get('analysisIdempotencyKey')}-${createHash('sha256').update(file.bytes).digest('hex').slice(0,16)}`:undefined}));
        return json(res,200,{entries,config:await customerVisualService.publicConfig()});
      }
      const resolution=await resolveSmartSubmission({root:projectRoot,...input,manual:smartManualFromForm(form),visualService:customerVisualService});
      if(!preparationRoute){
        if(form.get('previewPrompt')!=='true')return json(res,200,{resolution});
        const templates=input.templateFiles.map(f=>({template_name:f.name,sha256:createHash('sha256').update(f.bytes).digest('hex')}));
        for(const uid of input.catalogTemplateUids){const t=await loadTemplate({root:projectRoot,templateUid:uid});templates.push({template_uid:uid,template_name:t.template_info.template_name,sha256:t.reference_image.sha256,...t.selection_tags});}
        const {compilation}=await preparePromptCompilation({root:projectRoot,recipeEnabled:true,taskIntent:normalizeTaskIntent(resolution.task_intent),identityReferences:input.identityFiles.map((f,i)=>({ordinal:i+1,sha256:createHash('sha256').update(f.bytes).digest('hex'),role:i?'identity_support':'primary_front'})),templateReferences:templates.map((t,i)=>({...t,ordinal:input.identityFiles.length+i+1})),candidateSlateRequest:form.get('generationMode')==='api'?null:buildCandidateSlateRequest()});
        return json(res,200,{resolution,compilation});
      }
      assertSmartReady(resolution);
      const parent=await loadRun({root:projectRoot,runId:preparationRoute[1]});
      if(parent.manifest.customer_id&&parent.manifest.customer_id!==input.customerId)throw Object.assign(new Error('不能更换原任务的客户'),{status:422});
      if(parent.manifest.run_kind==='artifact_revision')throw Object.assign(new Error('修改版请使用单张修改入口继续。'),{status:409});
      let apiParameters=null;
      if(parent.manifest.image_api){apiParameters={n:Number(form.get('n')||parent.manifest.image_api.n||1),size:String(form.get('size')||parent.manifest.image_api.size||'auto'),quality:String(form.get('quality')||parent.manifest.image_api.quality||'auto')};if(!Number.isInteger(apiParameters.n)||apiParameters.n<1||apiParameters.n>4||!['auto','1024x1024','1024x1536','1536x1024'].includes(apiParameters.size)||!['auto','low','medium','high'].includes(apiParameters.quality))throw Object.assign(new Error('API 出图参数无效'),{status:422});}
      const catalog=await resolveCatalogSelectionForRun({root:projectRoot,templateSelectionId:String(form.get('templateSelectionId')||''),catalogTemplateUids:input.catalogTemplateUids,expectedTaskBrief:resolution.recommendation_brief});
      const compiled=await preparePromptCompilation({root:projectRoot,recipeEnabled:true,taskIntent:normalizeTaskIntent(resolution.task_intent),identityReferences:input.identityFiles.map((f,i)=>({ordinal:i+1,sha256:createHash('sha256').update(f.bytes).digest('hex'),role:i?'identity_support':'primary_front'})),templateReferences:[...input.templateFiles.map(f=>({template_name:f.name})),...catalog.catalogReferences.map(f=>({template_name:f.template_name}))].map((f,i)=>({...f,ordinal:input.identityFiles.length+i+1})),candidateSlateRequest:parent.manifest.candidate_slate_request||null});
      const revised=await reviseRunPreparation({root:projectRoot,runId:parent.runId,resolution,promptCompilation:compiled.compilation,identityFiles:input.identityFiles,templateFiles:input.templateFiles,resolvedCatalog:catalog,identitySource:input.identitySource,apiParameters});executor.releaseRun(parent.runId);
      return json(res,200,await publicRun(revised));
    }
    if (await imageApiHandler(req, res)) return;

    if (req.method === 'GET' && url.pathname === '/api/health') {
      await ensurePlaywright();
      return json(res, 200, {
        app: 'ready',
        mcp: { ready: mcpState.ready, owned: mcpState.owned, background:mcpState.background===true, tabGrouping:mcpState.tabGrouping??null },
        ai_prompt_writer: aiPromptWriter ? 'ready' : 'disabled',
        prompt_recipe: promptRecipeEnabled ? 'candidate_enabled' : 'inactive',
        face_angle_matching: 'disabled',
        artifact_revision: 'ready',
        image_api: 'ready',
        smart_task_resolution: 'ready',
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      await ensurePlaywright();
      const browser = mcpState.ready
        ? browserState
        : { ready: false, state: mcpState.state || 'service_unavailable', message: '本地 Playwright 服务尚未就绪。' };
      return json(res, 200, { app: 'ready', mcp: { ready: mcpState.ready, owned: mcpState.owned }, browser });
    }

    if (req.method === 'POST' && url.pathname === '/api/browser/probe') {
      await ensurePlaywright();
      browserState = mcpState.ready
        ? await probeBrowser()
        : { ready: false, state: mcpState.state || 'service_unavailable', message: '本地 Playwright 服务尚未就绪。' };
      return json(res, 200, { browser: browserState });
    }

    if (req.method === 'GET' && url.pathname === '/api/templates') {
      const filters = Object.fromEntries([
        'style_category',
        'portrait_scale',
        'face_angle',
        'identity_preservation_risk',
        'generation_difficulty',
        'q',
      ].map((name) => [name, url.searchParams.get(name) || '']));
      const catalog = await listTemplates({
        root: projectRoot,
        filters,
        limit: Number(url.searchParams.get('limit') || 124),
        offset: Number(url.searchParams.get('offset') || 0),
      });
      return json(res, 200, catalog);
    }

    const templateReferenceRoute = url.pathname.match(/^\/api\/templates\/(tpl_temp_aiimg_[a-z0-9_-]+)\/reference$/);
    if (templateReferenceRoute && req.method === 'GET') {
      const reference = await resolveTemplateReference({ root: projectRoot, templateUid: templateReferenceRoute[1] });
      const body = await readFile(reference.path);
      res.writeHead(200, {
        'content-type': reference.mime_type,
        'content-length': body.length,
        'cache-control': 'no-store',
        'content-disposition': `inline; filename="${templateReferenceRoute[1]}${extname(reference.path)}"`,
      });
      res.end(body);
      return;
    }

    const templateRoute = url.pathname.match(/^\/api\/templates\/(tpl_temp_aiimg_[a-z0-9_-]+)$/);
    if (templateRoute && req.method === 'GET') {
      return json(res, 200, { template: await loadTemplate({ root: projectRoot, templateUid: templateRoute[1] }) });
    }

    if (await templateSelectionApi(req, res)) return;
    if (await faceTagApi(req, res)) return;
    if (await templateStyleApi(req, res)) return;
    if (await templateStyleFacetsV2Api(req, res)) return;

    if (req.method === 'GET' && url.pathname === '/api/runs') {
      const runs = await listRuns({
        root: projectRoot,
        includeExcluded: url.searchParams.get('includeExcluded') === 'true',
        artifactsOnly: url.searchParams.get('artifactsOnly') !== 'false',
        limit: Number(url.searchParams.get('limit') || 100),
      });
      return json(res, 200, { runs });
    }

    if (req.method === 'POST' && url.pathname === '/api/history/import') {
      const request = new Request('http://localhost/api/history/import', { method: 'POST', headers: req.headers, body: req, duplex: 'half' });
      const form = await request.formData();
      const run = await createHistoricalRun({
        root: projectRoot,
        customerName: String(form.get('customerName') || ''),
        prompt: String(form.get('prompt') || ''),
        identityFiles: await formFiles(form, 'identity'),
        templateFiles: await formFiles(form, 'templates'),
        resultFiles: await formFiles(form, 'results'),
        referencePlan: {
          identityAngles: form.getAll('identityAngles').map(String),
          targetAngle: String(form.get('targetAngle') || 'frontal'),
          targetFraming: String(form.get('targetFraming') || 'half_body'),
        },
        customerContext: { intendedUse: String(form.get('intendedUse') || 'historical portrait record') },
        source: { batch_label: String(form.get('batchLabel') || 'manual-web-import') },
      });
      const imported = await loadRun({ root: projectRoot, runId: run.runId });
      return json(res, 201, {
        runId: imported.runId,
        manifest: {
          status: imported.manifest.status,
          customer_name: imported.manifest.customer_name,
          identity_count: imported.manifest.identity_references?.length || 0,
          template_count: imported.manifest.template_references?.length || 0,
          history_import: imported.manifest.history_import,
          artifacts: (imported.manifest.artifacts || []).map((artifact) => ({
            artifact_id: artifact.artifact_id,
            ordinal: artifact.ordinal,
            width: artifact.width,
            height: artifact.height,
            mime_type: artifact.mime_type,
          })),
        },
      });
    }


    if (req.method === 'GET' && url.pathname === '/api/ai/providers/status') {
      const opencodex = await inspectOpenCodexHealth();
      return json(res, 200, { providers: foundationProviders.statuses().map((item) => item.id === 'opencodex' ? { ...item, ...opencodex } : item) });
    }
    if (req.method === 'GET' && url.pathname === '/api/customers') {
      return json(res, 200, { customers: await listCustomers({ root: projectRoot }) });
    }
    if (req.method === 'GET' && url.pathname === '/api/compounding/metrics') {
      return json(res, 200, await compounding.rebuildMetrics());
    }
    if (req.method === 'GET' && url.pathname === '/api/reviewer-calibration/status') {
      return json(res, 200, await loadReviewerCalibrationProjection({
        root: projectRoot,
        rubricVersion: REVIEW_RUBRIC.rubric_version,
      }));
    }
    const identityDuplicatesRoute = url.pathname.match(/^\/api\/customers\/(cust_[a-f0-9]{16})\/identity-sets\/duplicates$/);
    if (identityDuplicatesRoute && req.method === 'GET') {
      const customerId = identityDuplicatesRoute[1];
      const customer = JSON.parse(await readFile(join(projectRoot, 'data', 'customers', customerId, 'customer.json'), 'utf8'));
      const identitySets = await listIdentitySets({ root: projectRoot, customerId });
      const runs = await listRuns({ root: projectRoot, includeExcluded: true, artifactsOnly: false, limit: 500 });
      const referencedIdentitySetIds = runs
        .map((run) => run.customer_identity_source?.identity_set_id)
        .filter(Boolean);
      return json(res, 200, { plan: buildIdentityDedupPlan({ customer, identitySets, referencedIdentitySetIds }) });
    }
    const identitySetsRoute = url.pathname.match(/^\/api\/customers\/(cust_[a-f0-9]{16})\/identity-sets$/);
    if (identitySetsRoute && req.method === 'GET') {
      return json(res, 200, { customer_id: identitySetsRoute[1], identity_sets: await listIdentitySets({ root: projectRoot, customerId: identitySetsRoute[1] }) });
    }
    if (identitySetsRoute && req.method === 'POST') {
      const request = new Request('http://localhost/identity-sets', { method: 'POST', headers: req.headers, body: req, duplex: 'half' });
      const form = await request.formData();
      const files = await formFiles(form, 'identity');
      const roles = form.getAll('identityRoles').map(String);
      const identitySet = await createIdentitySet({ root: projectRoot, customerId: identitySetsRoute[1], displayName: String(form.get('displayName') || ''), files: files.map((file, index) => ({ ...file, role: roles[index] || (index === 0 ? 'primary_front' : 'identity_support') })) });
      return json(res, 201, { identity_set: identitySet });
    }
    const identitySetAppendRoute = url.pathname.match(/^\/api\/customers\/(cust_[a-f0-9]{16})\/identity-sets\/(ids_[a-f0-9]{24})\/append$/);
    if (identitySetAppendRoute && req.method === 'POST') {
      const request = new Request('http://localhost/identity-set-append', { method: 'POST', headers: req.headers, body: req, duplex: 'half' });
      const form = await request.formData();
      const result = await appendIdentitySet({
        root: projectRoot,
        customerId: identitySetAppendRoute[1],
        identitySetId: identitySetAppendRoute[2],
        files: await formFiles(form, 'identity'),
      });
      return json(res, result.no_changes ? 200 : 201, result);
    }
    const identityReferenceManagementRoute = url.pathname.match(/^\/api\/customers\/(cust_[a-f0-9]{16})\/identity-sets\/(ids_[a-f0-9]{24})\/references\/(\d+)$/);
    if (identityReferenceManagementRoute && ['PATCH', 'DELETE'].includes(req.method)) {
      const body = await readJson(req);
      const options = {
        root: projectRoot,
        customerId: identityReferenceManagementRoute[1],
        identitySetId: identityReferenceManagementRoute[2],
        referenceOrdinal: Number(identityReferenceManagementRoute[3]),
        expectedReferenceSha256: String(body.expected_reference_sha256 || ''),
        expectedActiveIdentitySetId: String(body.expected_active_identity_set_id || ''),
      };
      const result = req.method === 'PATCH'
        ? await renameIdentityReference({ ...options, name: String(body.name || '') })
        : await removeIdentityReference(options);
      return json(res, result.idempotent_replay || result.no_changes ? 200 : 201, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/prompt-compilations') {
      const body = await readJson(req);
      const apiPortrait = body.generationMode === 'api';
      const intent = body.taskIntent || {};
      const taskIntent = normalizeTaskIntent(apiPortrait ? {...intent,useCase:intent.useCase || intent.use_case || 'custom'} : intent);
      const identityCount = Math.max(1, Number(body.identityReferenceTotal || 1));
      const identityFaceAngles = Array.isArray(body.identityFaceAngles) ? body.identityFaceAngles.map(String) : [];
      const identityReferences = Array.from({ length: identityCount }, (_, index) => ({
        ordinal: index + 1,
        sha256: '',
        role: index === 0 ? 'primary_front' : 'identity_support',
        face_angle: identityFaceAngles[index] || '',
      }));
      const templates = Array.isArray(body.templates) && body.templates.length ? body.templates : [{ ordinal: identityCount + 1, sha256: '', template_name: '当前模板' }];
      const candidateSlateRequest = apiPortrait ? null : buildCandidateSlateRequest();
      const { compilation } = await preparePromptCompilation({
        root: projectRoot,
        recipeEnabled: apiPortrait || promptRecipeEnabled,
        taskIntent,
        identityReferences,
        templateReferences: templates,
        candidateSlateRequest,
        guidance: { active_guidance: [], active_corrections: [], shadow_corrections: [] },
      });
      return json(res, 200, {
        compilation,
        ...(promptRecipeEnabled ? { preview: buildPromptRecipePreview(compilation) } : {}),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/runs') {
      const request = new Request('http://localhost/api/runs', { method: 'POST', headers: req.headers, body: req, duplex: 'half' });
      const form = await request.formData();
      const templateSelectionId = form.get('templateSelectionId') ? String(form.get('templateSelectionId')) : null;
      const catalogTemplateUids = form.getAll('catalogTemplateUids').map(String).filter(Boolean);
      const templateDecisionIdempotencyKey = form.get('templateDecisionIdempotencyKey') ? String(form.get('templateDecisionIdempotencyKey')) : null;
      const runCreationIdempotencyKey = form.get('runCreationIdempotencyKey') ? String(form.get('runCreationIdempotencyKey')) : null;
      const customerId = form.get('customerId') ? String(form.get('customerId')) : null;
      if (customerId && !/^cust_[a-f0-9]{16}$/.test(customerId)) throw new Error('Invalid customer id');
      const identitySetId = form.get('identitySetId') ? String(form.get('identitySetId')) : null;
      const uploadedIdentityFiles = await formFiles(form, 'identity');
      const selectedIdentity = identitySetId && customerId ? await materializeIdentitySet({ root: projectRoot, customerId, identitySetId }) : null;
      const requestedIdentityOrdinals = form.getAll('identityReferenceOrdinals').map(Number);
      const explicitIdentitySelection = requestedIdentityOrdinals.length > 0 || form.has('primaryIdentityReferenceOrdinal');
      const selectedIdentityInput = selectedIdentity ? selectCustomerIdentityFiles({
        customerId,
        identitySetId,
        materialized: selectedIdentity,
        selectedOrdinals: requestedIdentityOrdinals,
        primaryOrdinal: form.get('primaryIdentityReferenceOrdinal'),
        uploadedFiles: uploadedIdentityFiles,
        explicitSelection: explicitIdentitySelection,
      }) : null;
      if (!selectedIdentity && requestedIdentityOrdinals.length) throw new Error('Saved customer photo selection requires a customer identity group');
      let identityFiles = selectedIdentityInput?.files?.length ? selectedIdentityInput.files : uploadedIdentityFiles;
      let templateFiles = await formFiles(form, 'templates');
      const sourceRunId=String(form.get('sourceRunId')||'');
      if(sourceRunId){
        if(identitySetId)throw new Error('沿用参考图不能同时选择另一照片池');
        const reused=await materializeReusedReferences({root:projectRoot,sourceRunId,customerId,references:JSON.parse(form.get('reuseReferences')||'[]'),identityFiles,templateFiles});
        identityFiles=reused.identityFiles;templateFiles=reused.templateFiles;
      }
      const identityFaceAngles = form.getAll('identityFaceAngles').map(String);
      const templateFaceAngles = form.getAll('templateFaceAngles').map(String);
      const faceAngleAnalysis = parseFaceAngleSubmission({
        identityRaw: form.get('identityFacePoseObservations'),
        uploadedTemplateRaw: form.get('templateFacePoseObservations'),
        catalogTemplateRaw: form.get('catalogTemplateFacePoseObservations'),
        matchRaw: form.get('faceAngleMatch'),
        pipelineVersionRaw: form.get('faceAnglePipelineVersion'),
        identityFileCount: identityFiles.length,
        uploadedTemplateCount: templateFiles.length,
        catalogTemplateUids,
      });
      const derivedIdentityFaceAngles = faceAngleAnalysis?.identity_observations.map((item) => item.legacy_angle) || [];
      const derivedTemplateFaceAngles = faceAngleAnalysis?.uploaded_template_observations.map((item) => item.legacy_angle) || [];
      const effectiveIdentityFaceAngles = identityFaceAngles.length ? identityFaceAngles : derivedIdentityFaceAngles;
      const effectiveTemplateFaceAngles = templateFaceAngles.length ? templateFaceAngles : derivedTemplateFaceAngles;
      const submittedIdentityCoverage = form.getAll('identityAngles').map(String);
      const effectiveIdentityCoverage = submittedIdentityCoverage.length
        ? submittedIdentityCoverage
        : [...new Set(derivedIdentityFaceAngles.filter(Boolean))];
      const smartResolution=form.get('smartTask')==='true'?await resolveSmartSubmission({root:projectRoot,customerId,identityFiles,templateFiles,catalogTemplateUids,identitySetId,manual:smartManualFromForm(form),visualService:customerVisualService}):null;
      if(smartResolution)assertSmartReady(smartResolution);
      const taskIntent = normalizeTaskIntent(smartResolution?.task_intent || { useCase: form.get('intendedUse'), targetFraming: form.get('targetFraming'), targetFaceAngle: form.get('targetIntentAngle'), temperamentKeywords: form.getAll('temperamentKeywords'), layoutIntent: form.get('layoutIntent'), userSupplement: form.get('userSupplement') });
      const templateSelectionTaskBrief = catalogTemplateUids.length ? (smartResolution?.recommendation_brief || templateTaskBriefFromRunForm(form, customerId)) : null;
      const identityReferencesForPrompt = identityFiles.map((file, index) => ({
        ordinal: index + 1,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
        role: file.role || (index === 0 ? 'primary_front' : 'identity_support'),
        face_angle: file.face_angle || effectiveIdentityFaceAngles[index] || '',
      }));
      const templateReferencesForPrompt = [];
      for (let index = 0; index < templateFiles.length; index += 1) templateReferencesForPrompt.push({
        ordinal: identityFiles.length + index + 1,
        sha256: createHash('sha256').update(templateFiles[index].bytes).digest('hex'),
        template_name: templateFiles[index].name,
        face_angle: effectiveTemplateFaceAngles[index] || '',
      });
      for (let index = 0; index < catalogTemplateUids.length; index += 1) {
        const template = await loadTemplate({ root: projectRoot, templateUid: catalogTemplateUids[index] });
        const analyzedCatalogPose = faceAngleAnalysis?.catalog_template_observations?.[catalogTemplateUids[index]];
        templateReferencesForPrompt.push({
          ordinal: identityFiles.length + templateFiles.length + index + 1,
          sha256: template.reference_image.sha256,
          template_uid: template.template_uid,
          template_name: template.template_info.template_name,
          ...template.selection_tags,
          ...(analyzedCatalogPose?.reliability === 'reliable' ? { face_angle: analyzedCatalogPose.legacy_angle } : {}),
        });
      }
      const guidance = await (await import('./learning-projection.mjs')).loadReviewGuidance({ root: projectRoot });
      const candidateSlateRequest = buildCandidateSlateRequest();
      const preparedPrompt = await preparePromptCompilation({
        root: projectRoot,
        recipeEnabled: Boolean(smartResolution)||promptRecipeEnabled,
        taskIntent,
        identityReferences: identityReferencesForPrompt,
        templateReferences: templateReferencesForPrompt,
        candidateSlateRequest,
        guidance,
        aiPromptWriter,
      });
      const promptCompilation = preparedPrompt.compilation;
      const aiPromptDraft = preparedPrompt.aiPromptDraft;
      const run = await createRunSnapshot({
        root: projectRoot,
        customerName: String(form.get('customerName') || ''),
        prompt: promptCompilation.compiled_prompt,
        identityFiles,
        templateFiles,
        templateSelectionId,
        catalogTemplateUids,
        templateDecisionIdempotencyKey,
        runCreationIdempotencyKey,
        customerId,
        templateSelectionTaskBrief,
        sourceRunId: sourceRunId || null,
        taskResolution: smartResolution,
        referencePlan: {
          identityAngles: effectiveIdentityCoverage,
          targetAngle: String(form.get('targetAngle') || ''),
          templateAngle: String(form.get('templateAngle') || ''),
          targetFraming: String(form.get('targetFraming') || ''),
          templateFraming: String(form.get('templateFraming') || ''),
        },
        customerContext: {
          businessDomain: String(form.get('businessDomain') || ''),
          intendedUse: String(form.get('intendedUse') || ''),
        },
        taskIntent,
        promptCompilation,
        candidateSlateRequest,
        aiPromptDraft,
        customerIdentitySource: selectedIdentityInput?.source || null,
        faceAngleAnalysis,
      });
      if (customerId && uploadedIdentityFiles.length && String(form.get('saveIdentitySet') || '') === 'true') {
        await createIdentitySet({ root: projectRoot, customerId, displayName: String(form.get('customerName') || ''), files: uploadedIdentityFiles.map((file, index) => ({ ...file, role: index === 0 ? 'primary_front' : 'identity_support' })) });
      }
      return json(res, run.idempotent_replay ? 200 : 201, {
        runId: run.runId,
        status: run.manifest.status,
        idempotentReplay: run.idempotent_replay === true,
        referencePreflight: run.manifest.reference_preflight,
        message: '任务意图与最终提示词已保存，尚未上传。',
        promptCompilation,
        candidateSlateRequest,
        aiPromptDraft,
      });
    }

    const referenceFileRoute = url.pathname.match(/^\/api\/runs\/(run-[a-zA-Z0-9-]+)\/references\/(identity|template)\/(\d+)\/file$/);
    if (referenceFileRoute && req.method === 'GET') {
      const [, runId, kind, index] = referenceFileRoute;
      const run = await loadRun({ root: projectRoot, runId });
      const reference = resolveRunReferenceFile({ run, kind, index });
      const body = await readFile(reference.path);
      res.writeHead(200, {
        'content-type': types[extname(reference.path)] || 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store',
        'content-disposition': `inline; filename="${String(reference.filename).replace(/["\r\n]/g, '')}"`,
      });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/vendor/fabric.mjs') {
      const body = await readFile(fabricModulePath);
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'public, max-age=31536000, immutable',
      });
      res.end(body);
      return;
    }

    const artifactFileRoute = url.pathname.match(/^\/api\/runs\/(run-[a-zA-Z0-9-]+)\/artifacts\/(artifact-[a-zA-Z0-9-]+)\/file$/);
    if (artifactFileRoute && req.method === 'GET') {
      const [, runId, artifactId] = artifactFileRoute;
      const run = await loadRun({ root: projectRoot, runId });
      const artifact = run.manifest.artifacts?.find((item) => item.artifact_id === artifactId);
      if (!artifact) return json(res, 404, { error: 'Artifact not found' });
      const artifactPath = resolve(artifact.path);
      const withinRun = relative(resolve(run.runDir), artifactPath);
      if (withinRun.startsWith('..') || isAbsolute(withinRun)) return json(res, 400, { error: 'Artifact path is outside the run' });
      const body = await readFile(artifactPath);
      res.writeHead(200, {
        'content-type': artifact.mime_type || types[extname(artifactPath)] || 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store',
        'content-disposition': `inline; filename="${String(artifact.filename || 'artifact').replace(/["\r\n]/g, '')}"`,
      });
      res.end(body);
      return;
    }

    const annotationPreviewRoute = url.pathname.match(/^\/api\/runs\/(run-[a-zA-Z0-9-]+)\/artifacts\/(artifact-[a-zA-Z0-9-]+)\/annotations\/latest\/preview$/);
    if (annotationPreviewRoute && req.method === 'GET') {
      const [, runId, artifactId] = annotationPreviewRoute;
      const run = await loadRun({ root: projectRoot, runId });
      const artifact = run.manifest.artifacts?.find((item) => item.artifact_id === artifactId);
      if (!artifact) return json(res, 404, { error: 'Artifact not found' });
      const annotation = run.manifest.artifact_annotations?.[artifactId] || null;
      if (!annotation) return json(res, 404, { error: 'Artifact annotation not found' });
      const previewPath = resolveAnnotationPreview({ artifact, annotation });
      const body = await readFile(previewPath);
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': body.length,
        'cache-control': 'no-store',
        'content-disposition': 'inline; filename="annotated-preview.png"',
      });
      res.end(body);
      return;
    }

    const annotationRoute = url.pathname.match(/^\/api\/runs\/(run-[a-zA-Z0-9-]+)\/artifacts\/(artifact-[a-zA-Z0-9-]+)\/annotations\/latest$/);
    if (annotationRoute && req.method === 'GET') {
      const [, runId, artifactId] = annotationRoute;
      const loaded = await loadArtifactAnnotation({ root: projectRoot, runId, artifactId });
      return json(res, 200, {
        runId,
        artifactId,
        annotation: loaded.annotation,
        state: loaded.state,
        preview_url: loaded.annotation ? `${url.pathname}/preview` : null,
      });
    }
    if (annotationRoute && req.method === 'POST') {
      const [, runId, artifactId] = annotationRoute;
      const request = new Request(`http://localhost${url.pathname}`, { method: 'POST', headers: req.headers, body: req, duplex: 'half' });
      const form = await request.formData();
      const rawState = String(form.get('state') || '');
      const preview = form.get('preview');
      if (!rawState) return json(res, 400, { error: 'ArtifactAnnotation state is required' });
      if (!preview || typeof preview.arrayBuffer !== 'function' || !preview.size) {
        return json(res, 400, { error: 'ArtifactAnnotation preview is required' });
      }
      const saved = await saveArtifactAnnotation({
        root: projectRoot,
        runId,
        artifactId,
        payload: JSON.parse(rawState),
        previewBytes: Buffer.from(await preview.arrayBuffer()),
      });
      const annotation = saved.manifest.artifact_annotations[artifactId];
      return json(res, 201, {
        runId,
        artifactId,
        annotation,
        preview_url: `${url.pathname}/preview`,
      });
    }

    const artifactRevisionRoute = url.pathname.match(/^\/api\/runs\/(run-[a-zA-Z0-9-]+)\/artifacts\/(artifact-[a-zA-Z0-9-]+)\/revisions$/);
    if (artifactRevisionRoute && req.method === 'POST') {
      const [, parentRunId, parentArtifactId] = artifactRevisionRoute;
      const body = await readJson(req);
      if (body.confirmed !== true) return json(res, 409, { error: 'Artifact revision confirmation is required' });
      const parent=await loadRun({root:projectRoot,runId:parentRunId});
      if(parent.manifest.image_api){
        if(req.headers['x-image-api-client']!=='workstation' || (req.headers.origin && new URL(req.headers.origin).host!==req.headers.host))return json(res,403,{error:'仅允许工作台同源请求'});
        const input=await prepareApiArtifactRevision({root:projectRoot,parentRunId,parentArtifactId,instruction:body.instruction,includeAnnotations:body.includeAnnotations===true,annotationSessionId:body.annotationSessionId});
        if(body.expectedApiConfig)input.expectedApiConfig={baseUrl:body.expectedApiConfig.baseUrl,model:body.expectedApiConfig.model};
        return json(res,200,await imageApiRevisionService.submit(String(body.jobKey||''),input));
      }
      const child = await createArtifactRevisionRun({ root: projectRoot, parentRunId, parentArtifactId });
      return json(res, 201, {
        runId: child.runId,
        parentRunId,
        parentArtifactId,
        status: child.manifest.status,
        schemaVersion: child.manifest.schema_version,
        annotationSessionId: child.manifest.revision_source.annotation_session_id,
      });
    }

    const reviewSuggestionRoute = url.pathname.match(/^\/api\/runs\/(run-[a-zA-Z0-9-]+)\/artifacts\/(artifact-[a-zA-Z0-9-]+)\/review-suggestion$/);
    if (reviewSuggestionRoute && req.method === 'GET') {
      const [, runId, artifactId] = reviewSuggestionRoute;
      const run = await loadRun({ root: projectRoot, runId });
      const suggestion = run.manifest.review_suggestions?.[artifactId] || null;
      return json(res, 200, { state: suggestion ? 'suggested' : 'disabled_pending_contract', suggestion });
    }
    if (reviewSuggestionRoute && req.method === 'POST') {
      return json(res, 409, { error: { code: 'disabled_pending_contract', message: 'AI review suggestions are disabled until an exact image and structured-output model contract passes.' } });
    }

    const artifactRoute = url.pathname.match(/^\/api\/runs\/(run-[a-zA-Z0-9-]+)\/artifacts\/(artifact-[a-zA-Z0-9-]+)\/review$/);
    if (artifactRoute && req.method === 'POST') {
      const [, runId, artifactId] = artifactRoute;
      const body = await readJson(req);
      const reviewed = await saveArtifactReview({ root: projectRoot, runId, artifactId, review: body });
      const humanReview = reviewed.manifest.artifact_reviews[artifactId];
      const correction = await compounding.recordHumanCorrection({ runId, artifactId, humanReview });
      let outcomeBridge = { status: 'deferred', reason: 'bridge_not_applicable' };
      try {
        outcomeBridge = await compounding.bridgeRunOutcome({ runId });
      } catch (error) {
        await recordRunEvent({ root: projectRoot, runId, type: 'TemplateOutcomeBridgeDeferred', data: { reason: 'bridge_error', message: String(error?.message || error) } });
        outcomeBridge = { status: 'deferred', reason: 'bridge_error' };
      }
      return json(res, 201, {
        runId,
        artifactId,
        review: humanReview,
        reviewStatus: reviewed.manifest.review_status,
        correction,
        outcomeBridge,
      });
    }

    const importRoute = url.pathname.match(/^\/api\/runs\/(run-[a-zA-Z0-9-]+)\/artifacts\/import$/);
    if (importRoute && req.method === 'POST') {
      const [, runId] = importRoute;
      const request = new Request(`http://localhost${url.pathname}`, { method: 'POST', headers: req.headers, body: req, duplex: 'half' });
      const form = await request.formData();
      const imported = await importArtifacts({ root: projectRoot, runId, files: await formFiles(form, 'results'), captureMethod: 'manual_import' });
      executor.releaseRun(runId);
      return json(res, 201, { runId, status: imported.manifest.status, artifacts: imported.manifest.artifacts });
    }

    const runRoute = url.pathname.match(/^\/api\/runs\/(run-[a-zA-Z0-9-]+)(?:\/(stage|submit|results|review|capture|comparison|preference|record))?$/);
    if (runRoute) {
      const [, runId, action] = runRoute;

      if (req.method === 'GET' && !action) {
        return json(res, 200, await publicRun(await loadRun({ root: projectRoot, runId })));
      }

      if (req.method === 'DELETE' && !action) {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
          return json(res, 403, { error: '仅允许工作台同源删除。' });
        }
        const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'application/json') return json(res, 415, { error: '需要 JSON 请求。' });
        const body = await readJson(req);
        const result = await discardSavedRun({ root: projectRoot, runId, confirmed: body?.confirmed });
        captureAutomation.stop(runId);
        executor.releaseRun(runId);
        return json(res, 200, result);
      }

      if (req.method === 'POST' && action === 'stage') {
        const body = await readJson(req);
        const run = await loadRun({ root: projectRoot, runId });
        if(Number(run.manifest.submission_attempt_count||0)>0||run.manifest.artifacts?.length)return json(res,200,{runId,state:run.manifest.status==='submitted'||run.manifest.artifacts?.length?'already_submitted':'already_attempted',retryAutomatically:false});
        if (!isArtifactRevisionRun(run)) assertTemplateSelectionLinked(run);
        if (!isArtifactRevisionRun(run) && !run.manifest.submission_attempt_count) await assertTemplatesNotRejected({root:projectRoot,templateUids:(run.manifest.template_references||[]).map(t=>t.template_uid).filter(Boolean),imageHashes:(run.manifest.template_references||[]).map(t=>t.sha256).filter(Boolean)});
        const state = await ensurePlaywright();
        if (!state.ready) return json(res, 503, { error: 'Playwright 尚未连接默认 Chrome。' });
        const result = await executor.stageRun({ run, confirmed: body.confirmed === true });
        if (result.state === 'awaiting_submission_confirmation' && !result.sharedStaging && run.manifest.status !== 'staged') {
          await recordRunEvent({ root: projectRoot, runId, type: 'RunStaged', data: { executor: 'playwright-mcp-extension', recovered: result.alreadyStaged === true } });
        } else if (result.state !== 'awaiting_submission_confirmation' && !result.sharedStaging) {
          await recordRunEvent({ root: projectRoot, runId, type: 'RunStageFailed', data: result });
        }
        return json(res, 200, { runId, ...result });
      }

      if (req.method === 'POST' && action === 'submit') {
        const body = await readJson(req);
        if (body.confirmed !== true) throw new Error('Submission confirmation is required');
        const run = await loadRun({ root: projectRoot, runId });
        if(Number(run.manifest.submission_attempt_count||0)>0||run.manifest.artifacts?.length)return json(res,200,{runId,state:run.manifest.status==='submitted'||run.manifest.artifacts?.length?'already_submitted':'already_attempted',retryAutomatically:false});
        if (!isArtifactRevisionRun(run)) assertTemplateSelectionLinked(run);
        if (!isArtifactRevisionRun(run) && !run.manifest.submission_attempt_count) await assertTemplatesNotRejected({root:projectRoot,templateUids:(run.manifest.template_references||[]).map(t=>t.template_uid).filter(Boolean),imageHashes:(run.manifest.template_references||[]).map(t=>t.sha256).filter(Boolean)});
        if (!executor.hasStagedSession(runId)) return json(res, 409, {
          error: {
            code: 'run_stage_session_required',
            message: '当前服务没有该任务的已装载会话；请先重新装载原 Run。系统没有登记发送尝试。',
          },
          state: 'stage_required',
          retryAutomatically: false,
        });
        const requestSnapshot=executor.stagedRequestSnapshot(runId);
        if(!requestSnapshot || requestSnapshot.prompt!==(isArtifactRevisionRun(run)?String(run.prompt).trim():buildGenerationPrompt(run))){executor.releaseRun(runId);return json(res,409,{error:'提示词在装载后已变化，请重新装载原任务；尚未发送。'});}
        const expectedSnapshot=buildSubmissionSnapshot(run,{prompt:requestSnapshot.prompt});
        if((requestSnapshot.preparation_revision_id||null)!==(expectedSnapshot.preparation_revision_id||null)||JSON.stringify(requestSnapshot.references)!==JSON.stringify(expectedSnapshot.references)){executor.releaseRun(runId);return json(res,409,{error:'参考图或准备信息在装载后已变化，请重新装载原任务；尚未发送。'});}
        const attempt = await beginRunSubmissionAttempt({ root: projectRoot, runId,requestSnapshot,expectedPreparationRevision:requestSnapshot.preparation_revision_id||null });
        if (!attempt.started) return json(res, 200, {
          runId,
          state: attempt.state,
          previousState: attempt.previousState,
          retryAutomatically: false,
        });
        const result = await executor.submitRun({ run: attempt.runBefore, confirmed: true });
        if (result.state === 'submitted') {
          await recordRunEvent({ root: projectRoot, runId, type: 'RunSubmitted', data: { attempt_id: attempt.attemptId, submission_attempt: result.submissionAttempt, capture_context: result.captureContext || null } });
        } else if (result.state === 'submission_uncertain') {
          await recordRunEvent({ root: projectRoot, runId, type: 'RunSubmissionUncertain', data: { ...result, attempt_id: attempt.attemptId, submission_attempt: result.submissionAttempt, capture_context: result.captureContext || null } });
        } else if (result.submissionAttempt) {
          await recordRunEvent({ root: projectRoot, runId, type: 'RunSubmissionFailed', data: { ...result, attempt_id: attempt.attemptId, submission_attempt: result.submissionAttempt } });
        }
        if (result.submissionAttempt) captureAutomation.start(runId);
        return json(res, 200, { runId, ...result });
      }

      if (req.method === 'POST' && action === 'capture') {
        const client = executor.clientForCapture(runId);
        const captured = await captureRunArtifacts({ root: projectRoot, runId, adapter: resultCapture, client });
        if (captured.manifest.artifacts.length) executor.releaseRun(runId);
        return json(res, 200, { runId, capture: captured.manifest.capture, artifacts: captured.manifest.artifacts });
      }

      if (req.method === 'POST' && action === 'comparison') {
        const body = await readJson(req);
        const compared = await saveAestheticComparison({
          root: projectRoot,
          runId,
          artifactAId: String(body.artifactAId || ''),
          artifactBId: String(body.artifactBId || ''),
          outcome: String(body.outcome || ''),
          notes: String(body.notes || ''),
        });
        const comparison = compared.manifest.aesthetic_comparisons.at(-1) || null;
        return json(res, 201, { runId, comparison, comparisonCount: compared.manifest.aesthetic_comparisons.length });
      }

      if (req.method === 'POST' && action === 'preference') {
        const body = await readJson(req);
        const preferred = await savePreference({
          root: projectRoot,
          runId,
          decision: String(body.decision || ''),
          winnerArtifactId: body.winnerArtifactId ? String(body.winnerArtifactId) : null,
          notes: String(body.notes || ''),
        });
        let outcomeBridge = { status: 'deferred', reason: 'final_preference_pending' };
        try {
          outcomeBridge = await compounding.bridgeRunOutcome({ runId });
        } catch (error) {
          await recordRunEvent({ root: projectRoot, runId, type: 'TemplateOutcomeBridgeDeferred', data: { reason: 'bridge_error', message: String(error?.message || error) } });
          outcomeBridge = { status: 'deferred', reason: 'bridge_error' };
        }
        return json(res, 201, { runId, preference: preferred.manifest.preference, status: preferred.manifest.status, outcomeBridge });
      }

      if (req.method === 'POST' && action === 'record') {
        const body = await readJson(req);
        const updated = await updateRunRecord({
          root: projectRoot,
          runId,
          customerName: String(body.customerName || ''),
          prompt: String(body.prompt || ''),
          batchLabel: String(body.batchLabel || ''),
          intendedUse: String(body.intendedUse || ''),
        });
        const projected = await loadRun({ root: projectRoot, runId });
        return json(res, 200, {
          runId,
          eventType: 'RunRecordUpdated',
          record: {
            customer_name: projected.manifest.customer_name,
            prompt: projected.prompt,
            batch_label: projected.manifest.history_import?.batch_label || '',
            intended_use: projected.manifest.customer_context?.intended_use || '',
            record_revision: updated.manifest.record_revision || 0,
          },
        });
      }

      if (req.method === 'POST' && action === 'results') {
        const request = new Request(`http://localhost${url.pathname}`, { method: 'POST', headers: req.headers, body: req, duplex: 'half' });
        const form = await request.formData();
        const saved = await saveResultFiles({ root: projectRoot, runId, files: await formFiles(form, 'results') });
        executor.releaseRun(runId);
        return json(res, 201, { runId, status: saved.manifest.status, results: saved.manifest.results });
      }

      if (req.method === 'POST' && action === 'review') {
        const body = await readJson(req);
        const reviewed = await saveReview({ root: projectRoot, runId, review: body });
        return json(res, 201, { runId, review: reviewed.manifest.latest_review, reviewStatus: reviewed.manifest.review_status });
      }
    }

    if (req.method === 'GET' && (url.pathname === '/tutorial' || url.pathname.startsWith('/tutorial/'))) {
      const requestedTutorial = (url.pathname === '/tutorial' || url.pathname === '/tutorial/')
        ? 'tutorial.html'
        : url.pathname.slice('/tutorial/'.length);
      if (!requestedTutorial || requestedTutorial.includes('..')) return json(res, 400, { error: 'Invalid tutorial path' });
      const tutorialPath = join(tutorialRoot, requestedTutorial);
      const tutorialBody = await readFile(tutorialPath);
      res.writeHead(200, { 'content-type': types[extname(tutorialPath)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(tutorialBody);
      return;
    }

    const requested = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    if (requested.includes('..')) return json(res, 400, { error: 'Invalid path' });
    const path = join(publicRoot, requested);
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': types[extname(path)] || 'application/octet-stream',
      'cache-control': 'no-store',
      ...(extname(path) === '.html' ? { 'content-security-policy': contentSecurityPolicy } : {}),
    });
    res.end(body);
  } catch (error) {
    const message = String(error?.message || error);
    if (error instanceof CatalogRunIntegrationError) {
      json(res, error.status || 409, {
        error: {
          code: error.code,
          message,
          details: Array.isArray(error.details) ? error.details : [],
          ...(error.runId ? { run_id: error.runId } : {}),
        },
      });
      return;
    }
    const status = Number(error?.status || error?.statusCode) || (error?.code === 'ENOENT' ? 404 : (error?.code === 'ESTALE' || /confirm/i.test(message) ? 409 : 400));
    if (String(error?.code || '').startsWith('run_creation_') || error?.code === 'duplicate_run_creation_idempotency_key') {
      json(res, status, {
        error: {
          code: error.code,
          message,
          ...(error.runId ? { run_id: error.runId } : {}),
        },
      });
      return;
    }
    json(res, status, { error: message });
  }
});

server.listen(port, '127.0.0.1', () => {
  const boundPort = Number(server.address()?.port || port);
  console.log(`AI IMG GEN web: http://127.0.0.1:${boundPort}`);
  captureAutomation.resume().catch(() => {});
});
