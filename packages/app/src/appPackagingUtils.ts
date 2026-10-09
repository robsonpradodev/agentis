import type { AppManifest } from '@agentis/core';

type DefinitionFacetKey =
  | 'contract'
  | 'frontend'
  | 'components'
  | 'storage'
  | 'orchestration'
  | 'brainPolicy'
  | 'permissionsV3'
  | 'quality'
  | 'artifacts'
  | 'projections';

export type DefinitionFacets = Partial<Pick<AppManifest, DefinitionFacetKey>>;

/** Keep App package import/export symmetric as definition facets evolve. */
export function definitionFacets(source: DefinitionFacets): DefinitionFacets {
  return {
    contract: source.contract,
    frontend: source.frontend,
    components: source.components,
    storage: source.storage,
    orchestration: source.orchestration,
    brainPolicy: source.brainPolicy,
    permissionsV3: source.permissionsV3,
    quality: source.quality,
    artifacts: source.artifacts,
    projections: source.projections,
  };
}

export function hasAgenticDefinition(manifest: AppManifest): boolean {
  return (
    manifest.manifestVersion === 3 ||
    Object.values(definitionFacets(manifest)).some((facet) => facet !== undefined)
  );
}

/** Split a seed document on paragraph boundaries for workspace-local re-indexing. */
export function chunkDocument(content: string, maxChars = 960): string[] {
  const text = content.trim();
  if (text.length <= maxChars) return text ? [text] : [];
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    const block = paragraph.trim();
    if (!block) continue;
    if (current && current.length + block.length + 2 > maxChars) {
      chunks.push(current);
      current = '';
    }
    if (block.length > maxChars) {
      if (current) chunks.push(current);
      current = '';
      for (let index = 0; index < block.length; index += maxChars) {
        chunks.push(block.slice(index, index + maxChars));
      }
      continue;
    }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) chunks.push(current);
  return chunks;
}
