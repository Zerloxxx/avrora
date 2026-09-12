// Фоновый воркер: тяжёлые переборы не блокируют интерфейс и 3D-сцену.
import { designSearch, layoutCompare, optimizePlanes, vulnerableSatellites, coverageGrid, deploymentPlan, optimizeBatches, pairFailures, spareSearch, monteCarlo,
  routeStrategies, backupPaths } from './sim.js';

const TOOLS = { optimize: optimizePlanes, vulnerable: vulnerableSatellites, coverage: coverageGrid, deployment: deploymentPlan,
  batches: optimizeBatches, pairs: pairFailures, spares: spareSearch, montecarlo: monteCarlo, design: designSearch, layouts: layoutCompare,
  strategies: routeStrategies, backup: backupPaths };

self.onmessage = ev => {
  const { type, scenario, opts = {} } = ev.data;
  const onProgress = (done, total, extra) => self.postMessage({ type: 'progress', done, total, extra });
  try {
    const fn = TOOLS[type];
    if (!fn) throw new Error('Неизвестный инструмент: ' + type);
    self.postMessage({ type: 'done', result: fn(scenario, { ...opts, onProgress }) });
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e?.message || e) });
  }
};
