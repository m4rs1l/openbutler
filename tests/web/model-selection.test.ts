import { describe, expect, it } from 'vitest';
import { modelRouteKey, projectModelSelection } from '../../web/src/model-selection.js';

const models = [
  { providerId: 'first', providerName: 'first', modelId: 'model', name: 'Model' },
  { providerId: 'second', providerName: 'second', modelId: 'model', name: 'Other route' },
];
const runtime = {
  providerId: 'first',
  modelId: 'model',
  reasoningDefault: 'medium',
  reasoningVariants: [
    { id: 'low', label: 'Az' },
    { id: 'medium', label: 'Orta' },
    { id: 'high', label: 'High' },
  ],
};

describe('composer model capabilities', () => {
  it('shows the runtime effort, the single source the next request will use', () => {
    const view = projectModelSelection(runtime, models)!;
    expect(view.reasoning).toMatchObject({ value: 'medium', label: 'Orta', canSelect: true });
    // What the selector shows is what send() submits; there is no local override left.
    expect(view.reasoning.value).toBe(runtime.reasoningDefault);
  });
  it('distinguishes providers with the same model ID', () => {
    expect(modelRouteKey(models[0])).not.toBe(modelRouteKey(models[1]));
    expect(projectModelSelection(runtime, models)!.models.map((model) => model.selected)).toEqual([true, false]);
  });
  it('keeps fixed and unavailable reasoning passive without inventing options', () => {
    expect(projectModelSelection({ ...runtime, reasoningVariants: [] }, models)!.reasoning).toMatchObject({
      value: null,
      options: [],
      canSelect: false,
    });
    expect(projectModelSelection({ ...runtime, reasoningVariants: [runtime.reasoningVariants[0]] }, models)!.reasoning).toMatchObject({
      value: 'low',
      canSelect: false,
    });
    expect(projectModelSelection(undefined, models)).toBeNull();
  });
  it('shows a pending mid-run pick immediately while the runtime stays on the running model', () => {
    // A run blocks the switch: the session remembers the pick and the view follows
    // it at once, while runtime (the next request's real input) keeps model A.
    const view = projectModelSelection(runtime, models, models[1])!;
    expect(view.deferred).toBe(true);
    expect(view.modelLabel).toBe('Other route');
    expect(view.providerLabel).toBe('second');
    expect(view.models.map((model) => model.selected)).toEqual([false, true]);
    // Once the server accepts the pick the pending argument is dropped: nothing is deferred.
    expect(projectModelSelection(runtime, models, models[0])!.deferred).toBe(false);
    expect(projectModelSelection(runtime, models)!.deferred).toBe(false);
    // A pick the catalog no longer lists cannot be shown as chosen.
    expect(projectModelSelection(runtime, models, { providerId: 'gone', modelId: 'gone' })!.deferred).toBe(false);
  });
});
