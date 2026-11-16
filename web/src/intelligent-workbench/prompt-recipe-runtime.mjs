import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildAiPromptWriterInput } from './ai-prompt-writer.mjs';
import { compileDeterministicPrompt } from './prompt-compilation.mjs';
import { PromptRecipeError } from './prompt-recipe.mjs';

export async function loadValidatedIdentityTransferAsset({ root }) {
  try {
    return JSON.parse((await readFile(join(root, 'prompts', 'validated-identity-transfer.json'), 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new PromptRecipeError('identity_transfer_block_missing', 'Validated identity-transfer prompt asset is missing');
    }
    if (error instanceof SyntaxError) {
      throw new PromptRecipeError('identity_transfer_block_invalid', 'Validated identity-transfer prompt asset is not valid JSON');
    }
    throw error;
  }
}

export async function preparePromptCompilation({
  root,
  recipeEnabled = false,
  taskIntent,
  identityReferences,
  templateReferences,
  candidateSlateRequest = null,
  guidance = {},
  aiPromptWriter = null,
} = {}) {
  const activeGuidance = Array.isArray(guidance.active_guidance) ? guidance.active_guidance : [];
  let aiPromptDraft = null;
  if (aiPromptWriter) {
    try {
      aiPromptDraft = await aiPromptWriter.write(buildAiPromptWriterInput({
        task_intent: taskIntent,
        template_references: templateReferences,
        active_guidance: activeGuidance,
      }));
    } catch {
      aiPromptDraft = null;
    }
  }

  if (!recipeEnabled) {
    return {
      compilation: compileDeterministicPrompt({
        taskIntent,
        identityReferences,
        templateReferences,
        activeGuidance,
        candidateSlateRequest,
        aiPromptDraft,
      }),
      aiPromptDraft,
      recipe_enabled: false,
    };
  }

  const identityTransferBlock = await loadValidatedIdentityTransferAsset({ root });
  return {
    compilation: compileDeterministicPrompt({
      taskIntent,
      identityReferences,
      templateReferences,
      candidateSlateRequest,
      aiPromptDraft,
      promptRecipe: {
        version: 2,
        promptInputMode: 'reference_image',
        identityTransferBlock,
        activeCorrections: Array.isArray(guidance.active_corrections) ? guidance.active_corrections : [],
        shadowCorrections: Array.isArray(guidance.shadow_corrections) ? guidance.shadow_corrections : [],
      },
    }),
    aiPromptDraft,
    recipe_enabled: true,
  };
}
