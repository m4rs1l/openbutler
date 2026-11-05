import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { projectModelSelection } from '../model-selection.js';
import type { ModelChoice } from '../types.js';
import { ModelSelector } from './model-selector.js';

const models: ModelChoice[] = [
  { providerId: 'first', providerName: 'first', modelId: 'model', name: 'Model' },
  { providerId: 'second', providerName: 'second', modelId: 'model', name: 'Other route' },
];
const runtime = {
  providerId: 'first',
  modelId: 'model',
  reasoningDefault: 'medium',
  reasoningVariants: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
  ],
};

function render(pending: ModelChoice | null) {
  return renderToStaticMarkup(
    createElement(ModelSelector, {
      projection: projectModelSelection(runtime, models, pending),
      pending: false,
      error: null,
      disabled: false,
      pendingModel: pending,
      open: false,
      onOpenChange: () => {},
      resetKey: undefined,
      onSelectModel: async () => true,
      onSelectReasoning: async () => true,
      onRetry: () => {},
    }),
  );
}

describe('model selector trigger', () => {
  it('labels the accepted model without a waiting mark', () => {
    const markup = render(null);
    expect(markup).toContain('>Model<');
    expect(markup).not.toContain('composer-model-selector__pending-dot');
  });
  it('labels a pending mid-run pick immediately without a waiting mark nobody asked for', () => {
    const markup = render(models[1]);
    expect(markup).toContain('>Other route<');
    expect(markup).not.toContain('composer-model-selector__pending-dot');
  });
});
