/**
 * Prism installs its own JSON-based worker protocol when it detects a worker.
 * This worker uses the app's structured message protocol instead.
 */
const workerGlobal = globalThis as typeof globalThis & {
  Prism?: { disableWorkerMessageHandler?: boolean };
};

workerGlobal.Prism = {
  ...(workerGlobal.Prism ?? {}),
  disableWorkerMessageHandler: true,
};
