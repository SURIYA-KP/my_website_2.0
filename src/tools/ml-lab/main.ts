// ML Lab entry point: theme cache, tabs, both labs, and a small debug hook for tests.
import { initTabs, onThemeChange } from '../../lib/ui';
import { readTheme, type Theme } from './colors';
import { initClustering } from './cluster-ui';
import { initNN } from './nn-ui';
import * as kmeans from './kmeans';
import * as mlp from './mlp';
import * as datasets from './datasets';
import * as rng from './rng';
import { Trainer } from './trainer';

export function init() {
  let th: Theme = readTheme();
  const theme = () => th;

  const cluster = initClustering(theme);
  const nn = initNN(theme);

  initTabs(document, (group, tab) => {
    if (group !== 'mllab') return;
    if (tab === 'nn') nn.shown();
    else { nn.hidden(); cluster.redraw(); }
  });

  onThemeChange(() => {
    // the toggle flips data-theme synchronously; read the new tokens on the next frame
    requestAnimationFrame(() => {
      th = readTheme();
      cluster.redraw();
      nn.redraw();
    });
  });

  // Debug / test hook: pure modules + live UI state. Read-only use; nothing is stored.
  (window as unknown as { __mllab: unknown }).__mllab = {
    kmeans, mlp, datasets, rng, Trainer,
    get cluster() { return cluster.state; },
    get nn() { return nn.state; },
  };
}
