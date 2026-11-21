import ranks from 'js-tiktoken/ranks/p50k_base';
import { startWorker } from './worker-core';

startWorker('p50k_base', ranks);
