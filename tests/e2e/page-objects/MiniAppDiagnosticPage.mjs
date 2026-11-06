import { MiniAppWorkloadPage } from './MiniAppWorkloadPage.mjs';

/** Temporary rendering experiments; never used by the acceptance workload. */
export class MiniAppDiagnosticPage extends MiniAppWorkloadPage {
  observeGeometry() {
    return this.execute(() => {
      for (const frame of document.querySelectorAll('iframe[data-app-id][data-run-scope="active"]')) {
        const child = frame.contentWindow;
        child.__miniappGeometry = { resizes: 0 };
        child.addEventListener('resize', () => child.__miniappGeometry.resizes++);
      }
    });
  }

  setRenderingExperiment(mode) {
    return this.execute(mode => {
      for (const frame of document.querySelectorAll('iframe[data-app-id][data-run-scope="active"]')) {
        frame.style.display = mode === 'display-none' ? 'none' : 'block';
        frame.style.contentVisibility = mode === 'content-visibility-hidden' ? 'hidden' : '';
      }
    }, mode);
  }

  diagnosticStates() {
    return this.execute(() => [...document.querySelectorAll('iframe[data-app-id][data-run-scope="active"]')].map(frame => {
      const child = frame.contentWindow;
      return { id: frame.dataset.appId, ...child.workloadSnapshot(), width: child.innerWidth, height: child.innerHeight,
        rect: { width: frame.getBoundingClientRect().width, height: frame.getBoundingClientRect().height },
        resizes: child.__miniappGeometry?.resizes ?? 0,
        visible: frame.checkVisibility({ checkVisibilityCSS: true }) };
    }));
  }
}
