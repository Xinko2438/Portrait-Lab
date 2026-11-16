import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  importTemplateCatalog,
  inspectTemplateSource,
  rebuildTemplateCatalog,
} from '../src/template-catalog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function compactInspection(inspection) {
  return {
    source_namespace: inspection.source_namespace,
    expected_count: inspection.expected_count,
    template_count: inspection.template_count,
    image_count: inspection.image_count,
    index_count: inspection.index_count,
    unique_template_ids: inspection.unique_template_ids,
    unique_image_hashes: inspection.unique_image_hashes,
    duplicate_image_groups: inspection.duplicate_image_groups,
  };
}

async function main() {
  const action = process.argv[2];
  const sourceRoot = argument('--source-root');
  const expectedCount = Number(argument('--expected-count') || 124);
  if (action === 'inspect') {
    if (!sourceRoot) throw new Error('--source-root is required');
    const inspection = await inspectTemplateSource({ sourceRoot, expectedCount });
    console.log(JSON.stringify({ action, status: 'validated', ...compactInspection(inspection) }, null, 2));
    return;
  }
  if (action === 'import') {
    if (!sourceRoot) throw new Error('--source-root is required');
    const result = await importTemplateCatalog({ root: projectRoot, sourceRoot, expectedCount });
    console.log(JSON.stringify({
      action,
      status: 'imported',
      import_batch_id: result.import_batch_id,
      added_templates: result.added_templates,
      unchanged_templates: result.unchanged_templates,
      added_assets: result.added_assets,
      inspection: result.inspection,
      summary: result.catalog.summary,
    }, null, 2));
    return;
  }
  if (action === 'rebuild') {
    const projection = await rebuildTemplateCatalog({ root: projectRoot });
    console.log(JSON.stringify({ action, status: 'rebuilt', summary: projection.summary }, null, 2));
    return;
  }
  throw new Error('Usage: import-template-catalog.mjs <inspect|import|rebuild> [--source-root <absolute path>]');
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'error', error: String(error?.message || error) }));
  process.exitCode = 1;
});
