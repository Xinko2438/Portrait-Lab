import { readFileSync } from 'node:fs';

const rubricUrl = new URL('../../knowledge/tutorials/portrait-reference-selection-and-aesthetic-rubric/distilled/rubric.json', import.meta.url);
const source = readFileSync(rubricUrl, 'utf8').replace(/^\uFEFF/, '');
export const REVIEW_RUBRIC = JSON.parse(source);
export const REVIEW_DIMENSIONS = new Map(REVIEW_RUBRIC.dimensions.map((dimension) => [dimension.id, dimension]));
export const REVIEW_DIAGNOSTIC_GROUPS = new Map(
  (REVIEW_RUBRIC.diagnostic_groups || []).map((group) => [group.id, group]),
);
export const REVIEW_DIAGNOSTICS = new Map(
  (REVIEW_RUBRIC.diagnostic_groups || []).flatMap((group) => (
    (group.codes || []).map((diagnostic) => [diagnostic.code, { ...diagnostic, group: group.id, group_label: group.label, customer_scoped: group.customer_scoped === true }])
  )),
);
