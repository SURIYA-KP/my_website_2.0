import ranks from 'js-tiktoken/ranks/cl100k_base';
import { startWorker } from './worker-core';

startWorker('cl100k_base', ranks);
