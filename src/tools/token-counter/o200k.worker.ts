import ranks from 'js-tiktoken/ranks/o200k_base';
import { startWorker } from './worker-core';

startWorker('o200k_base', ranks);
