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

function render(current: { providerId: string; modelId: string }) {
  return renderToStaticMarkup(
    createElement(ModelSelector, {
      projection: projectModelSelection({ ...runtime, ...current }, models),
      pending: false,
      error: null,
      disabled: false,
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
  it('labels the model this chat runs with, without a waiting mark', () => {
    const markup = render({ providerId: 'first', modelId: 'model' });
    expect(markup).toContain('>Model<');
    expect(markup).not.toContain('composer-model-selector__pending-dot');
  });
  it('labels the chat own model even when another route exists', () => {
    const markup = render({ providerId: 'second', modelId: 'model' });
    expect(markup).toContain('>Other route<');
    expect(markup).not.toContain('composer-model-selector__pending-dot');
  });
});
