import { resolve } from 'node:path';

export function resolveServerConfiguration({ sourceRoot, env = process.env } = {}) {
  const normalizedSourceRoot = resolve(String(sourceRoot || '.'));
  return Object.freeze({
    sourceRoot: normalizedSourceRoot,
    projectRoot: resolve(String(env.AI_IMG_GEN_PROJECT_ROOT || normalizedSourceRoot)),
    promptRecipeEnabled: env.AI_IMG_GEN_PROMPT_RECIPE_V1_ENABLED === 'true',
  });
}
