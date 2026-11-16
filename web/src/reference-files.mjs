import { isAbsolute, relative, resolve } from 'node:path';

const referenceCollections = {
  identity: 'identity_references',
  template: 'template_references',
};

export function resolveRunReferenceFile({ run, kind, index }) {
  const collectionName = referenceCollections[kind];
  if (!collectionName) throw new Error('Invalid reference kind');
  const parsedIndex = Number(index);
  if (!Number.isInteger(parsedIndex) || parsedIndex < 0) throw new Error('Invalid reference index');
  const reference = run?.manifest?.[collectionName]?.[parsedIndex];
  if (!reference?.path) throw new Error('Reference not found');
  const referencePath = resolve(reference.path);
  const withinRun = relative(resolve(run.runDir), referencePath);
  if (withinRun.startsWith('..') || isAbsolute(withinRun)) throw new Error('Reference path is outside the run');
  return {
    path: referencePath,
    filename: reference.filename || `reference-${parsedIndex + 1}`,
  };
}
