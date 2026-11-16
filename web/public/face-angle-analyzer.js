import {
  FACE_POSE_SCHEMA_VERSION,
  classifyExpression,
  classifyPose,
  poseFromTransformationMatrix,
} from './face-angle-core.js';

const DEFAULT_PACKAGE_VERSION = '1.0.1';
const DEFAULT_MODEL_SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';

function bounded(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('Local face-angle analysis timed out');
      error.code = 'face_angle_timeout';
      reject(error);
    }, milliseconds);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function faceCoverage(landmarks = []) {
  const usable = landmarks.filter((item) => Number.isFinite(Number(item?.x)) && Number.isFinite(Number(item?.y)));
  if (!usable.length) return 0;
  const xs = usable.map((item) => Number(item.x));
  const ys = usable.map((item) => Number(item.y));
  return round(Math.max(0, Math.max(...xs) - Math.min(...xs)) * Math.max(0, Math.max(...ys) - Math.min(...ys)));
}

async function defaultLoadVision({ wasmRoot, modelUrl }) {
  const { FaceLandmarker, FilesetResolver } = await import('/vendor/mediapipe/vision_bundle.mjs');
  const vision = await FilesetResolver.forVisionTasks(wasmRoot);
  const detector = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' },
    runningMode: 'IMAGE',
    numFaces: 2,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  return { detector, packageVersion: DEFAULT_PACKAGE_VERSION };
}

function unavailableObservation(context, state, faceCount = 0, coverage = null) {
  return {
    schema_version: FACE_POSE_SCHEMA_VERSION,
    source_kind: context.sourceKind,
    source_index: Number(context.sourceIndex || 0),
    source_sha256: String(context.sourceSha256 || ''),
    analyzer: context.analyzer,
    analysis_stage: 'fast_path',
    state,
    yaw_deg: null,
    pitch_deg: null,
    roll_deg: null,
    angle_family: 'unknown',
    legacy_angle: 'other',
    display_label: state === 'multiple_faces'
      ? '检测到多张脸'
      : state === 'no_face'
        ? '未检测到人脸'
        : state === 'face_too_small'
          ? '人脸过小'
          : state === 'timeout' ? '分析超时，请手动选择' : '无法自动判断',
    face_count: faceCount,
    face_coverage_ratio: coverage,
    reliability: state === 'face_too_small' ? 'low' : 'unavailable',
    expression: {
      state: 'unavailable',
      label: '表情信息不足',
      reliability: 'unavailable',
      source: 'none',
      semantic_temperament: 'not_inferred',
    },
    semantic_temperament: 'not_inferred',
  };
}

async function imageForDetection(source) {
  if (typeof Blob !== 'undefined' && source instanceof Blob && typeof globalThis.createImageBitmap === 'function') {
    const bitmap = await globalThis.createImageBitmap(source);
    return { image: bitmap, close: () => bitmap.close?.() };
  }
  return { image: source, close: () => {} };
}

function imageDimensions(source) {
  const width = Number(source?.naturalWidth || source?.videoWidth || source?.width || 0);
  const height = Number(source?.naturalHeight || source?.videoHeight || source?.height || 0);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('Image dimensions are unavailable for the local profile fallback');
  return { width, height };
}

async function defaultProfileFallback(source, context) {
  const prepared = await imageForDetection(source);
  try {
    const sourceDimensions = imageDimensions(prepared.image);
    const scale = Math.min(1, 640 / Math.max(sourceDimensions.width, sourceDimensions.height));
    const width = Math.max(1, Math.round(sourceDimensions.width * scale));
    const height = Math.max(1, Math.round(sourceDimensions.height * scale));
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const drawing = canvas.getContext('2d', { willReadFrequently: true });
    if (!drawing) throw new Error('Canvas is unavailable for the local profile fallback');
    drawing.drawImage(prepared.image, 0, 0, width, height);
    const rgba = drawing.getImageData(0, 0, width, height).data;
    const rgb = new Uint8Array(width * height * 3);
    for (let sourceOffset = 0, targetOffset = 0; sourceOffset < rgba.length; sourceOffset += 4) {
      rgb[targetOffset++] = rgba[sourceOffset];
      rgb[targetOffset++] = rgba[sourceOffset + 1];
      rgb[targetOffset++] = rgba[sourceOffset + 2];
    }
    const response = await fetch('/api/face-angle/profile-fallback', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-image-width': String(width),
        'x-image-height': String(height),
        'x-source-kind': String(context.sourceKind || 'identity'),
        'x-source-index': String(context.sourceIndex || 0),
        ...(context.sourceSha256 ? { 'x-source-sha256': String(context.sourceSha256) } : {}),
      },
      body: rgb,
    });
    if (!response.ok) throw new Error(`Local profile fallback returned HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload?.observation) throw new Error('Local profile fallback returned no observation');
    return payload.observation;
  } finally {
    prepared.close();
  }
}

export function createFaceAngleAnalyzer({
  wasmRoot = '/vendor/mediapipe/wasm',
  modelUrl = '/vendor/mediapipe/face_landmarker.task',
  modelSha256 = DEFAULT_MODEL_SHA256,
  packageVersion = DEFAULT_PACKAGE_VERSION,
  loadVision = defaultLoadVision,
  initializationTimeoutMs = 12_000,
  analysisTimeoutMs = 8_000,
  minimumFaceCoverage = 0.015,
  profileFallback = defaultProfileFallback,
} = {}) {
  if ([wasmRoot, modelUrl].some((value) => /^https?:\/\//i.test(String(value)))) {
    throw new Error('Face-angle analyzer assets must use local workstation URLs');
  }
  let state = 'idle';
  let loadError = null;
  let initialization = null;

  async function initialize() {
    if (!initialization) {
      state = 'loading';
      initialization = bounded(Promise.resolve(loadVision({ wasmRoot, modelUrl })), initializationTimeoutMs)
        .then((loaded) => {
          if (!loaded?.detector || typeof loaded.detector.detect !== 'function') throw new Error('Face Landmarker detector is unavailable');
          state = 'ready';
          return loaded;
        })
        .catch((error) => {
          state = error?.code === 'face_angle_timeout' ? 'timeout' : 'unavailable';
          loadError = error;
          throw error;
        });
    }
    return initialization;
  }

  async function analyzeFacePose(source, context = {}) {
    const analyzer = {
      name: 'mediapipe-face-landmarker',
      version: packageVersion,
      model_sha256: modelSha256,
    };
    const normalizedContext = { ...context, analyzer };
    async function useProfileFallback(primary, fallbackSource = source, expressionCategories = []) {
      if (typeof profileFallback !== 'function') return primary;
      try {
        const fallback = await profileFallback(fallbackSource, normalizedContext);
        if (fallback?.schema_version !== FACE_POSE_SCHEMA_VERSION || fallback.state !== 'usable') return primary;
        const authoritativeClassification = classifyPose(fallback);
        const fastExpression = classifyExpression(expressionCategories, fallback);
        const fallbackExpression = fallback.expression;
        const bestExpression = fastExpression.reliability === 'unavailable'
          && fallbackExpression
          && fallbackExpression.reliability !== 'unavailable'
          ? fallbackExpression
          : fastExpression;
        const expression = fallback.reliability === 'reliable'
          ? bestExpression
          : {
              ...bestExpression,
              state: 'unavailable_low_confidence',
              label: '表情待确认',
              reliability: 'low',
            };
        const classification = fallback.reliability === 'reliable'
          ? authoritativeClassification
          : {
              angle_family: authoritativeClassification.angle_family,
              legacy_angle: authoritativeClassification.legacy_angle,
              pose_detail: authoritativeClassification.pose_detail,
              display_label: fallback.display_label,
              pose_label: fallback.pose_label || fallback.display_label,
            };
        return {
          ...fallback,
          ...classification,
          expression,
          semantic_temperament: 'not_inferred',
          ...(primary?.state === 'usable' ? {
            estimator_comparison: {
              fast_yaw_deg: primary.yaw_deg,
              fast_pitch_deg: primary.pitch_deg,
              fast_roll_deg: primary.roll_deg,
              authoritative_yaw_deg: fallback.yaw_deg,
              authoritative_pitch_deg: fallback.pitch_deg,
              authoritative_roll_deg: fallback.roll_deg,
            },
          } : {}),
        };
      } catch (error) {
        console.warn(`Local profile fallback unavailable: ${String(error?.message || error)}`);
        return primary;
      }
    }
    let loaded;
    try {
      loaded = await initialize();
    } catch (error) {
      return useProfileFallback(unavailableObservation(normalizedContext, error?.code === 'face_angle_timeout' ? 'timeout' : 'model_unavailable'));
    }

    let prepared;
    try {
      prepared = await imageForDetection(source);
      const result = await bounded(Promise.resolve(loaded.detector.detect(prepared.image)), analysisTimeoutMs);
      const faces = Array.isArray(result?.faceLandmarks) ? result.faceLandmarks : [];
      const expressionCategories = result?.faceBlendshapes?.[0]?.categories || [];
      const faceCount = faces.length;
      if (!faceCount) return useProfileFallback(unavailableObservation(normalizedContext, 'no_face', 0, null), source, expressionCategories);
      if (faceCount !== 1) return unavailableObservation(normalizedContext, 'multiple_faces', faceCount, null);
      const coverage = faceCoverage(faces[0]);
      if (coverage < minimumFaceCoverage) return useProfileFallback(unavailableObservation(normalizedContext, 'face_too_small', 1, coverage), source, expressionCategories);
      const matrix = result?.facialTransformationMatrixes?.[0];
      const pose = poseFromTransformationMatrix(matrix);
      if (!pose.valid) return useProfileFallback(unavailableObservation(normalizedContext, 'invalid_matrix', 1, coverage), source, expressionCategories);
      const classification = classifyPose(pose);
      const fastObservation = {
        schema_version: FACE_POSE_SCHEMA_VERSION,
        source_kind: normalizedContext.sourceKind,
        source_index: Number(normalizedContext.sourceIndex || 0),
        source_sha256: String(normalizedContext.sourceSha256 || ''),
        analyzer: {
          ...analyzer,
          version: String(loaded.packageVersion || analyzer.version),
        },
        analysis_stage: 'fast_path',
        state: 'usable',
        yaw_deg: pose.yaw_deg,
        pitch_deg: pose.pitch_deg,
        roll_deg: pose.roll_deg,
        ...classification,
        face_count: 1,
        face_coverage_ratio: coverage,
        reliability: 'reliable',
        expression: classifyExpression(expressionCategories, pose),
        semantic_temperament: 'not_inferred',
      };
      return useProfileFallback(fastObservation, source, expressionCategories);
    } catch (error) {
      return useProfileFallback(unavailableObservation(normalizedContext, error?.code === 'face_angle_timeout' ? 'timeout' : 'error'));
    } finally {
      prepared?.close?.();
    }
  }

  return {
    analyzeFacePose,
    initialize,
    getState: () => ({ state, message: loadError ? String(loadError.message || loadError) : '' }),
  };
}

let defaultAnalyzer;

export function getDefaultFaceAngleAnalyzer() {
  if (!defaultAnalyzer) defaultAnalyzer = createFaceAngleAnalyzer();
  return defaultAnalyzer;
}
