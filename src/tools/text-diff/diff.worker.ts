/// <reference lib="webworker" />
// Runs line diffs and patch generation off the main thread so large inputs never freeze the tab.
import { createTwoFilesPatch } from 'diff';
import { computeDiff, type DiffOptions } from './engine';

export type WorkerRequest =
  | { id: number; type: 'diff'; a: string; b: string; options: DiffOptions }
  | { id: number; type: 'patch'; a: string; b: string; nameA: string; nameB: string; context: number };

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.type === 'diff') {
      const result = computeDiff(req.a, req.b, req.options, (phase, done, total) => {
        self.postMessage({ id: req.id, type: 'progress', phase, done, total });
      });
      self.postMessage({ id: req.id, type: 'result', result });
    } else {
      const patch = createTwoFilesPatch(req.nameA, req.nameB, req.a, req.b, undefined, undefined, { context: req.context });
      self.postMessage({ id: req.id, type: 'result', result: patch });
    }
  } catch (err) {
    self.postMessage({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
