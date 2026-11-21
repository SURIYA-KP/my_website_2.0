/// <reference lib="webworker" />
// Trains the network off the main thread so the page stays at 60 fps.
import { EngineCore, type EngineMsg } from './engine-core';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const core = new EngineCore((msg, transfer) => scope.postMessage(msg, transfer));
scope.onmessage = (e: MessageEvent<EngineMsg>) => core.handle(e.data);
