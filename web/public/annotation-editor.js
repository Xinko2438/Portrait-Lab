import {
  Canvas,
  Ellipse,
  FabricImage,
  FabricObject,
  IText,
  Line,
  Path,
  PencilBrush,
  Rect,
  version as fabricVersion,
} from '/vendor/fabric.mjs';
import { anchoredShapeGeometry, canEditStrokeWidth, nearestStrokeWidth, resolveEditorShortcut } from '/annotation-interactions.js';

const customProperties = ['annotationId', 'annotationType', 'reasonCode', 'annotationNote', 'mosaicVariant', 'annotationBounds'];
FabricObject.customProperties = customProperties;

const elements = {
  dialog: document.querySelector('#annotationDialog'),
  title: document.querySelector('#annotationTitle'),
  state: document.querySelector('#annotationSaveState'),
  close: document.querySelector('#closeAnnotation'),
  stage: document.querySelector('#annotationCanvasStage'),
  viewport: document.querySelector('#annotationCanvasViewport'),
  canvas: document.querySelector('#annotationCanvas'),
  color: document.querySelector('#annotationColor'),
  width: document.querySelector('#annotationWidth'),
  colorChoices: [...document.querySelectorAll('[data-annotation-color]')],
  widthChoices: [...document.querySelectorAll('[data-annotation-width]')],
  mosaicVariants: [...document.querySelectorAll('[data-mosaic-variant]')],
  tools: [...document.querySelectorAll('[data-annotation-tool]')],
  undo: document.querySelector('#undoAnnotation'),
  redo: document.querySelector('#redoAnnotation'),
  delete: document.querySelector('#deleteAnnotation'),
  clear: document.querySelector('#clearAnnotations'),
  zoomOut: document.querySelector('#zoomOutAnnotation'),
  zoomIn: document.querySelector('#zoomInAnnotation'),
  resetZoom: document.querySelector('#resetZoomAnnotation'),
  reason: document.querySelector('#annotationReason'),
  note: document.querySelector('#annotationNote'),
  overallNote: document.querySelector('#annotationOverallNote'),
  selectionLabel: document.querySelector('#annotationSelectionLabel'),
  objectHint: document.querySelector('#annotationObjectHint'),
  save: document.querySelector('#saveAnnotation'),
  revision: document.querySelector('#submitArtifactRevision'),
  revisionState: document.querySelector('#annotationRevisionState'),
};

let canvas = null;
let baseImage = null;
let current = null;
let activeTool = 'select';
let activeMosaicVariant = 'soft_blur';
let draftObject = null;
let draftStart = null;
let displayScale = 1;
let fitScale = 1;
let dirty = false;
let restoring = false;
let history = [];
let historyIndex = -1;

function newAnnotationId() {
  return `mark-${crypto.randomUUID()}`;
}

function setDirty(value = true) {
  dirty = value;
  elements.state.textContent = value ? '有未保存修改' : '批注已保存';
  elements.state.classList.toggle('dirty', value);
  updateRevisionEligibility();
}

function updateRevisionEligibility(message = '') {
  const annotationCount = Number(current?.latestAnnotation?.annotation_count || 0);
  const eligible = Boolean(current?.onSubmitRevision) && annotationCount > 0 && !dirty && !current?.revisionBusy;
  elements.revision.disabled = !eligible;
  if (message) {
    elements.revisionState.textContent = message;
    return;
  }
  if (current?.revisionBusy) elements.revisionState.textContent = '正在创建子任务并打开原对话，请勿重复点击。';
  else if (dirty) elements.revisionState.textContent = '请先保存最新批注，再继续修改。';
  else if (!annotationCount) elements.revisionState.textContent = '保存至少一个标记后可继续修改。';
  else if (!current?.onSubmitRevision) elements.revisionState.textContent = '当前页面没有启用继续修改流程。';
  else elements.revisionState.textContent = `已保存 ${annotationCount} 个标记，可以在原对话继续修改。`;
}

function selectedObject() {
  return canvas?.getActiveObject() || null;
}

function bindAnnotation(object, type) {
  object.set({
    annotationId: object.annotationId || newAnnotationId(),
    annotationType: type,
    reasonCode: object.reasonCode || 'other',
    annotationNote: object.annotationNote || '',
  });
  return object;
}

function setSelectionUi(object) {
  const selected = Boolean(object);
  elements.reason.disabled = !selected;
  elements.note.disabled = !selected;
  elements.delete.disabled = !selected;
  elements.selectionLabel.textContent = selected ? `已选中：${object.annotationType || '标记'}` : '还没有选中标记';
  elements.objectHint.textContent = selected ? '备注会与当前标记绑定并随批注一起保存。' : '先用画笔或形状圈出问题区域，再填写备注。';
  elements.reason.value = object?.reasonCode || 'other';
  elements.note.value = object?.annotationNote || '';
  if (object && canEditStrokeWidth(object.annotationType)) displayStrokeWidth(nearestStrokeWidth(object.strokeWidth));
}

function setTool(tool) {
  activeTool = tool;
  for (const button of elements.tools) button.classList.toggle('active', button.dataset.annotationTool === tool);
  if (!canvas) return;
  canvas.isDrawingMode = ['freehand', 'mosaic'].includes(tool);
  canvas.selection = tool === 'select';
  for (const object of canvas.getObjects()) object.set({ selectable: tool === 'select', evented: tool === 'select' });
  if (['freehand', 'mosaic'].includes(tool)) {
    const brush = new PencilBrush(canvas);
    brush.color = tool === 'mosaic' ? 'rgba(255,255,255,0.82)' : elements.color.value;
    brush.width = tool === 'mosaic' ? Number(elements.width.value) * 8 : Number(elements.width.value);
    canvas.freeDrawingBrush = brush;
  }
  canvas.discardActiveObject();
  setSelectionUi(null);
  canvas.requestRenderAll();
}

function setAnnotationColor(color) {
  elements.color.value = color;
  for (const button of elements.colorChoices) {
    button.classList.toggle('active', button.dataset.annotationColor.toLowerCase() === color.toLowerCase());
  }
  if (activeTool === 'freehand') setTool('freehand');
}

function displayStrokeWidth(width) {
  elements.width.value = String(width);
  for (const button of elements.widthChoices) {
    button.classList.toggle('active', button.dataset.annotationWidth === String(width));
  }
}

function applySelectedStrokeWidth(width) {
  const object = selectedObject();
  if (!object || !canEditStrokeWidth(object.annotationType)) return false;
  object.set({ strokeWidth: Number(width), strokeUniform: true });
  object.setCoords();
  canvas.requestRenderAll();
  commitHistory();
  return true;
}

function setAnnotationWidth(width) {
  displayStrokeWidth(width);
  if (applySelectedStrokeWidth(width)) return;
  if (['freehand', 'mosaic'].includes(activeTool)) setTool(activeTool);
}

function setMosaicVariant(variant) {
  activeMosaicVariant = variant;
  for (const button of elements.mosaicVariants) {
    button.classList.toggle('active', button.dataset.mosaicVariant === variant);
  }
  if (activeTool === 'mosaic') setTool('mosaic');
}

function editableState() {
  const state = canvas.toJSON(customProperties);
  delete state.backgroundImage;
  return state;
}

function updateHistoryControls() {
  elements.undo.disabled = historyIndex <= 0;
  elements.redo.disabled = historyIndex >= history.length - 1;
}

function commitHistory() {
  if (restoring || !canvas) return;
  const snapshot = JSON.stringify(editableState());
  if (history[historyIndex] === snapshot) return;
  history = history.slice(0, historyIndex + 1);
  history.push(snapshot);
  historyIndex = history.length - 1;
  updateHistoryControls();
  setDirty(true);
}

async function restoreHistory(index) {
  if (!canvas || index < 0 || index >= history.length) return;
  restoring = true;
  const background = baseImage;
  await canvas.loadFromJSON(JSON.parse(history[index]));
  canvas.backgroundImage = background;
  historyIndex = index;
  restoring = false;
  setTool('select');
  updateHistoryControls();
  setDirty(true);
  canvas.requestRenderAll();
}

function normalizedAnnotations() {
  const width = canvas.width || 1;
  const height = canvas.height || 1;
  return canvas.getObjects().map((object) => {
    const box = object.annotationBounds || object.getBoundingRect();
    const x = Math.max(0, Math.min(width, box.left));
    const y = Math.max(0, Math.min(height, box.top));
    const right = Math.max(x, Math.min(width, box.left + box.width));
    const bottom = Math.max(y, Math.min(height, box.top + box.height));
    return {
      annotation_id: object.annotationId,
      type: object.annotationType,
      ...(object.annotationType === 'mosaic' ? { effect_variant: object.mosaicVariant || 'soft_blur' } : {}),
      bounds: {
        x: x / width,
        y: y / height,
        width: (right - x) / width,
        height: (bottom - y) / height,
      },
      reason_code: object.reasonCode || 'other',
      note: object.annotationNote || '',
    };
  });
}

function fitCanvas() {
  if (!canvas || !current) return;
  const availableWidth = Math.max(280, elements.stage.clientWidth - 32);
  const availableHeight = Math.max(280, elements.stage.clientHeight - 32);
  fitScale = Math.min(1, availableWidth / current.artifact.width, availableHeight / current.artifact.height);
  displayScale = fitScale;
  applyDisplayScale();
}

function applyDisplayScale() {
  if (!canvas || !current) return;
  const width = Math.round(current.artifact.width * displayScale);
  const height = Math.round(current.artifact.height * displayScale);
  canvas.setDimensions({ width, height }, { cssOnly: true });
  elements.viewport.style.width = `${width}px`;
  elements.viewport.style.height = `${height}px`;
}

function zoomBy(factor) {
  displayScale = Math.max(fitScale * 0.5, Math.min(2, displayScale * factor));
  applyDisplayScale();
}

function pointer(event) {
  return canvas.getScenePoint(event.e);
}

function shapeStyle() {
  return {
    left: draftStart.x,
    top: draftStart.y,
    width: 1,
    height: 1,
    originX: 'left',
    originY: 'top',
    fill: 'rgba(0,0,0,0)',
    stroke: elements.color.value,
    strokeWidth: Number(elements.width.value),
    strokeUniform: true,
    selectable: false,
    evented: false,
  };
}

function beginShape(event) {
  if (!canvas || ['select', 'freehand', 'mosaic', 'text'].includes(activeTool)) return;
  draftStart = pointer(event);
  if (activeTool === 'rectangle') draftObject = bindAnnotation(new Rect(shapeStyle()), 'rectangle');
  if (activeTool === 'ellipse') draftObject = bindAnnotation(new Ellipse({ ...shapeStyle(), rx: 1, ry: 1 }), 'ellipse');
  if (activeTool === 'arrow') draftObject = new Line([draftStart.x, draftStart.y, draftStart.x, draftStart.y], { stroke: elements.color.value, strokeWidth: Number(elements.width.value), strokeUniform: true, selectable: false, evented: false });
  canvas.add(draftObject);
}

function updateShape(event) {
  if (!draftObject || !draftStart) return;
  const point = pointer(event);
  if (activeTool === 'arrow') {
    draftObject.set({ x2: point.x, y2: point.y });
  } else {
    const geometry = anchoredShapeGeometry(draftStart, point);
    draftObject.set(geometry);
    if (activeTool === 'ellipse') draftObject.set({ rx: geometry.width / 2, ry: geometry.height / 2 });
  }
  draftObject.setCoords();
  canvas.requestRenderAll();
}

function arrowPath(start, end) {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const head = Math.max(16, Number(elements.width.value) * 3);
  const left = { x: end.x - head * Math.cos(angle - Math.PI / 6), y: end.y - head * Math.sin(angle - Math.PI / 6) };
  const right = { x: end.x - head * Math.cos(angle + Math.PI / 6), y: end.y - head * Math.sin(angle + Math.PI / 6) };
  return `M ${start.x} ${start.y} L ${end.x} ${end.y} M ${end.x} ${end.y} L ${left.x} ${left.y} M ${end.x} ${end.y} L ${right.x} ${right.y}`;
}

function finishShape(event) {
  if (!draftObject || !draftStart) return;
  if (activeTool === 'arrow') {
    const end = pointer(event);
    canvas.remove(draftObject);
    draftObject = bindAnnotation(new Path(arrowPath(draftStart, end), {
      fill: '',
      stroke: elements.color.value,
      strokeWidth: Number(elements.width.value),
      strokeUniform: true,
      selectable: false,
      evented: false,
    }), 'arrow');
    canvas.add(draftObject);
  }
  draftObject = null;
  draftStart = null;
  commitHistory();
}

const mosaicEffects = {
  soft_blur: { blur: 7, veil: 0, grain: 0 },
  haze: { blur: 12, veil: 0.2, grain: 0 },
  frosted: { blur: 16, veil: 0.08, grain: 0.11 },
};

function clampMosaicBounds(bounds) {
  const left = Math.max(0, Math.floor(bounds.left));
  const top = Math.max(0, Math.floor(bounds.top));
  const right = Math.min(current.artifact.width, Math.ceil(bounds.left + bounds.width));
  const bottom = Math.min(current.artifact.height, Math.ceil(bounds.top + bounds.height));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function paintFrostedGrain(context, width, height, opacity) {
  if (!opacity) return;
  context.save();
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const shade = ((x * 17 + y * 31) % 29) / 29;
      context.fillStyle = `rgba(255,255,255,${opacity * shade})`;
      context.fillRect(x, y, 2, 2);
    }
  }
  context.restore();
}

async function replacePathWithMosaic(path) {
  const bounds = clampMosaicBounds(path.getBoundingRect());
  const mask = path.toCanvasElement({ enableRetinaScaling: false });
  const effect = mosaicEffects[activeMosaicVariant] || mosaicEffects.soft_blur;
  const raster = document.createElement('canvas');
  raster.width = bounds.width;
  raster.height = bounds.height;
  const context = raster.getContext('2d');
  const source = baseImage?.getElement();
  if (!source) {
    canvas.remove(path);
    return;
  }

  context.save();
  context.filter = `blur(${effect.blur}px)`;
  context.drawImage(source, -bounds.left, -bounds.top, current.artifact.width, current.artifact.height);
  context.restore();
  if (effect.veil) {
    context.fillStyle = `rgba(255,255,255,${effect.veil})`;
    context.fillRect(0, 0, bounds.width, bounds.height);
  }
  paintFrostedGrain(context, bounds.width, bounds.height, effect.grain);
  context.globalCompositeOperation = 'destination-in';
  context.drawImage(mask, 0, 0, bounds.width, bounds.height);

  canvas.remove(path);
  const image = await FabricImage.fromURL(raster.toDataURL('image/png'));
  bindAnnotation(image, 'mosaic');
  image.set({
    left: bounds.left,
    top: bounds.top,
    originX: 'left',
    originY: 'top',
    mosaicVariant: activeMosaicVariant,
    annotationBounds: bounds,
    selectable: false,
    evented: false,
  });
  canvas.add(image);
  canvas.requestRenderAll();
  commitHistory();
}

function addText(event) {
  if (activeTool !== 'text') return;
  const point = pointer(event);
  const object = bindAnnotation(new IText('输入说明', {
    left: point.x,
    top: point.y,
    fill: elements.color.value,
    fontFamily: 'Arial, sans-serif',
    fontSize: Math.max(24, Number(elements.width.value) * 4),
    selectable: true,
    evented: true,
  }), 'text');
  canvas.add(object);
  setTool('select');
  canvas.setActiveObject(object);
  object.enterEditing();
  object.selectAll();
  setSelectionUi(object);
  commitHistory();
}

function dataUrlToBlob(dataUrl) {
  const [header, encoded] = dataUrl.split(',');
  const mime = header.match(/data:([^;]+)/)?.[1] || 'image/png';
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}

async function saveAnnotation() {
  if (!canvas || !current) return;
  elements.save.disabled = true;
  elements.save.textContent = '正在保存';
  elements.state.textContent = '正在生成批注文件';
  try {
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    const payload = {
      editor_version: 'artifact-annotation-editor-v1',
      fabric_version: fabricVersion,
      canvas: { width: current.artifact.width, height: current.artifact.height },
      overall_note: elements.overallNote.value,
      state: editableState(),
      annotations: normalizedAnnotations(),
    };
    const preview = dataUrlToBlob(canvas.toDataURL({ format: 'png', quality: 1, multiplier: 1 }));
    const form = new FormData();
    form.set('state', JSON.stringify(payload));
    form.set('preview', preview, 'annotated-preview.png');
    const response = await fetch(`/api/runs/${encodeURIComponent(current.runId)}/artifacts/${encodeURIComponent(current.artifact.artifact_id)}/annotations/latest`, { method: 'POST', body: form });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `保存失败：${response.status}`);
    current.latestAnnotation = result.annotation;
    setDirty(false);
    elements.state.textContent = `已保存 ${result.annotation.annotation_count} 个标记`;
    await current.onSaved?.(result.annotation);
  } catch (error) {
    elements.state.textContent = `保存失败：${error.message}`;
    elements.state.classList.add('dirty');
  } finally {
    elements.save.disabled = false;
    elements.save.textContent = '保存批注';
  }
}

async function submitArtifactRevision() {
  if (!current || dirty || Number(current.latestAnnotation?.annotation_count || 0) < 1 || typeof current.onSubmitRevision !== 'function') return;
  current.revisionBusy = true;
  elements.save.disabled = true;
  updateRevisionEligibility();
  let completed = false;
  try {
    const result = await current.onSubmitRevision({
      runId: current.runId,
      artifactId: current.artifact.artifact_id,
      annotation: current.latestAnnotation,
    });
    const childRunId = String(result?.runId || result?.childRunId || '');
    const state = String(result?.state || '');
    updateRevisionEligibility(result?.message || (childRunId ? `子任务 ${childRunId} 已${state === 'submitted' ? '发送一次' : '进入处理流程'}。` : '子任务已进入处理流程。'));
    completed = ['submitted', 'submission_uncertain'].includes(state);
    if (completed) elements.dialog.close();
  } catch (error) {
    updateRevisionEligibility(`继续修改未完成：${error.message}`);
  } finally {
    if (current) {
      current.revisionBusy = false;
      elements.save.disabled = false;
      if (!completed) elements.revision.disabled = dirty || Number(current.latestAnnotation?.annotation_count || 0) < 1;
    }
  }
}

function requestClose() {
  if (dirty && !window.confirm('批注还没有保存，确定关闭吗？')) return;
  elements.dialog.close();
}

function installCanvasEvents() {
  canvas.on('mouse:down', (event) => {
    beginShape(event);
    addText(event);
  });
  canvas.on('mouse:move', updateShape);
  canvas.on('mouse:up', finishShape);
  canvas.on('path:created', async ({ path }) => {
    if (activeTool === 'mosaic') {
      await replacePathWithMosaic(path);
      return;
    }
    bindAnnotation(path, 'freehand');
    commitHistory();
  });
  canvas.on('selection:created', ({ selected }) => setSelectionUi(selected?.[0] || null));
  canvas.on('selection:updated', ({ selected }) => setSelectionUi(selected?.[0] || null));
  canvas.on('selection:cleared', () => setSelectionUi(null));
  canvas.on('object:modified', commitHistory);
  canvas.on('text:changed', () => setDirty(true));
}

async function loadBaseImage(url) {
  baseImage = await FabricImage.fromURL(url, { crossOrigin: 'anonymous' });
  baseImage.set({
    left: 0,
    top: 0,
    originX: 'left',
    originY: 'top',
    scaleX: current.artifact.width / baseImage.width,
    scaleY: current.artifact.height / baseImage.height,
    selectable: false,
    evented: false,
    excludeFromExport: true,
  });
  canvas.backgroundImage = baseImage;
}

async function loadLatestState() {
  const url = `/api/runs/${encodeURIComponent(current.runId)}/artifacts/${encodeURIComponent(current.artifact.artifact_id)}/annotations/latest`;
  const response = await fetch(url);
  const saved = await response.json();
  if (!response.ok) throw new Error(saved.error || `无法读取批注：${response.status}`);
  current.latestAnnotation = saved.annotation;
  restoring = true;
  if (saved.state?.state) await canvas.loadFromJSON(saved.state.state);
  await loadBaseImage(`/api/runs/${encodeURIComponent(current.runId)}/artifacts/${encodeURIComponent(current.artifact.artifact_id)}/file`);
  if (saved.state?.annotations) {
    const byId = new Map(saved.state.annotations.map((item) => [item.annotation_id, item]));
    for (const object of canvas.getObjects()) {
      const metadata = byId.get(object.annotationId);
      if (metadata) object.set({ annotationType: metadata.type, reasonCode: metadata.reason_code, annotationNote: metadata.note, mosaicVariant: metadata.effect_variant || object.mosaicVariant });
    }
  }
  elements.overallNote.value = saved.state?.overall_note || '';
  restoring = false;
  history = [JSON.stringify(editableState())];
  historyIndex = 0;
  updateHistoryControls();
  setDirty(false);
  elements.state.textContent = saved.annotation ? `已载入 ${saved.annotation.annotation_count} 个标记` : '尚未添加标记';
  canvas.requestRenderAll();
}

function disposeCanvas() {
  if (canvas) canvas.dispose();
  canvas = null;
  baseImage = null;
  current = null;
  history = [];
  historyIndex = -1;
  setSelectionUi(null);
}

function deleteSelectedAnnotation() {
  const object = selectedObject();
  if (!object) return;
  canvas.remove(object);
  canvas.discardActiveObject();
  setSelectionUi(null);
  commitHistory();
}

function handleEditorShortcut(event) {
  if (!elements.dialog.open || !canvas) return;
  const action = resolveEditorShortcut({
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    targetTag: event.target?.tagName,
    isContentEditable: Boolean(event.target?.isContentEditable),
    isTextEditing: Boolean(selectedObject()?.isEditing),
  });
  if (!action) return;
  event.preventDefault();
  if (action === 'delete') deleteSelectedAnnotation();
  if (action === 'undo') restoreHistory(historyIndex - 1);
  if (action === 'redo') restoreHistory(historyIndex + 1);
}

for (const button of elements.tools) button.addEventListener('click', () => setTool(button.dataset.annotationTool));
for (const button of elements.colorChoices) button.addEventListener('click', () => setAnnotationColor(button.dataset.annotationColor));
for (const button of elements.widthChoices) button.addEventListener('click', () => setAnnotationWidth(button.dataset.annotationWidth));
for (const button of elements.mosaicVariants) button.addEventListener('click', () => setMosaicVariant(button.dataset.mosaicVariant));
elements.color.addEventListener('input', () => setAnnotationColor(elements.color.value));
elements.reason.addEventListener('change', () => { const object = selectedObject(); if (object) { object.reasonCode = elements.reason.value; commitHistory(); } });
elements.note.addEventListener('input', () => { const object = selectedObject(); if (object) { object.annotationNote = elements.note.value; setDirty(true); } });
elements.note.addEventListener('change', commitHistory);
elements.overallNote.addEventListener('input', () => setDirty(true));
elements.undo.addEventListener('click', () => restoreHistory(historyIndex - 1));
elements.redo.addEventListener('click', () => restoreHistory(historyIndex + 1));
elements.delete.addEventListener('click', deleteSelectedAnnotation);
elements.clear.addEventListener('click', () => { if (!canvas?.getObjects().length || !window.confirm('确定清空这张图上的全部标记吗？')) return; canvas.remove(...canvas.getObjects()); commitHistory(); });
elements.zoomOut.addEventListener('click', () => zoomBy(0.8));
elements.zoomIn.addEventListener('click', () => zoomBy(1.25));
elements.resetZoom.addEventListener('click', fitCanvas);
elements.save.addEventListener('click', saveAnnotation);
elements.revision.addEventListener('click', submitArtifactRevision);
elements.close.addEventListener('click', requestClose);
elements.dialog.addEventListener('cancel', (event) => { event.preventDefault(); requestClose(); });
elements.dialog.addEventListener('close', disposeCanvas);
window.addEventListener('resize', () => { if (elements.dialog.open) fitCanvas(); });
document.addEventListener('keydown', handleEditorShortcut);

export async function openArtifactAnnotation({ runId, artifact, onSaved, onSubmitRevision }) {
  if (!runId || !artifact) throw new Error('缺少候选图信息');
  if (canvas) disposeCanvas();
  current = { runId, artifact, onSaved, onSubmitRevision, latestAnnotation: null, revisionBusy: false };
  elements.title.textContent = `候选 ${artifact.ordinal} · 批注修改`;
  elements.dialog.showModal();
  canvas = new Canvas(elements.canvas, {
    width: artifact.width,
    height: artifact.height,
    preserveObjectStacking: true,
    selection: true,
    perPixelTargetFind: true,
    targetFindTolerance: 6,
  });
  installCanvasEvents();
  await loadLatestState();
  fitCanvas();
  setTool('select');
}
