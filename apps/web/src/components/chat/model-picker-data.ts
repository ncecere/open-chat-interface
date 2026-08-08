import { type CatalogModel, findModelLab, type ModelCapability } from '@oci/shared';
import { Brain, Eye, FileText, Globe2, Image, SlidersHorizontal, Wrench, Zap } from 'lucide-react';

export const CAPABILITY_ICONS: Partial<Record<ModelCapability, typeof Eye>> = {
  vision: Eye,
  reasoning: Brain,
  effort_control: SlidersHorizontal,
  tool_calling: Wrench,
  fast: Zap,
  pdf_comprehension: FileText,
  image_generation: Image,
  web_search: Globe2,
};

export const CAPABILITY_LABELS: Record<ModelCapability, string> = {
  vision: 'Vision',
  reasoning: 'Reasoning',
  effort_control: 'Effort control',
  tool_calling: 'Tool calling',
  fast: 'Fast',
  pdf_comprehension: 'PDF comprehension',
  image_generation: 'Image generation',
  web_search: 'Web search',
};

export const FILTER_CAPABILITIES: ModelCapability[] = [
  'fast',
  'vision',
  'reasoning',
  'effort_control',
  'tool_calling',
  'image_generation',
  'pdf_comprehension',
  'web_search',
];

export interface LabFilter {
  id: string;
  name: string;
}

export function labsFrom(models: CatalogModel[]): LabFilter[] {
  const seen = new Map<string, LabFilter>();

  for (const model of models) {
    const lab = findModelLab(model.labId);
    if (lab && !seen.has(lab.id)) seen.set(lab.id, { id: lab.id, name: lab.name });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function matchesSearch(model: CatalogModel, query: string): boolean {
  if (!query.trim()) return true;
  const needle = query.trim().toLowerCase();

  return (
    model.displayName.toLowerCase().includes(needle) ||
    model.providerLabel.toLowerCase().includes(needle) ||
    (model.description?.toLowerCase().includes(needle) ?? false) ||
    (findModelLab(model.labId)?.name.toLowerCase().includes(needle) ?? false)
  );
}

export function matchesCapabilities(
  model: CatalogModel,
  selected: ModelCapability[],
  combine: boolean,
): boolean {
  if (selected.length === 0) return true;
  return combine
    ? selected.every((capability) => model.capabilities.includes(capability))
    : selected.some((capability) => model.capabilities.includes(capability));
}

export function modelDescription(model: CatalogModel): string {
  const configured = model.description?.trim();
  if (configured) return configured;

  const supported = model.capabilities
    .map((capability) => CAPABILITY_LABELS[capability])
    .filter(Boolean);
  if (supported.length > 0) return `Supports ${supported.join(', ').toLowerCase()}`;
  return `Available through ${model.providerLabel}`;
}
