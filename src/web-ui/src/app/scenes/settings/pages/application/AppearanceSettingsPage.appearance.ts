import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const appearanceSettingsAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'appearance-settings',
  parts: [
    { id: 'root' }, { id: 'content' },

    { id: 'packageSection' }, { id: 'packagePreview' }, { id: 'packageBuiltinTheme' },
    { id: 'packageActions' },
    { id: 'packageDiagnostics' }, { id: 'packageDiagnosticsHeader' },
    { id: 'packageDiagnosticsGroup' }, { id: 'packageDiagnosticIssue' },
    { id: 'packageDiagnosticAllowedParts' },
    { id: 'packageMissingSelection' },
    { id: 'marketDialog' }, { id: 'marketToolbar' }, { id: 'marketBrowse' },
    { id: 'marketResults' }, { id: 'marketGrid' },
    { id: 'marketCard' }, { id: 'marketPreview' }, { id: 'marketCardBody' },
    { id: 'marketStatus' }, { id: 'marketEmpty' }, { id: 'marketError' },
    { id: 'marketDetail' }, { id: 'marketDetailPreview' }, { id: 'marketDetailBody' },
    { id: 'marketWarning' }, { id: 'marketReleaseList' }, { id: 'marketRelease' },
    { id: 'marketActions' }, { id: 'marketNav' }, { id: 'marketWorkflow' },
    { id: 'marketManualSubmit' },
    { id: 'marketSubmissionList' }, { id: 'marketSubmission' },
    { id: 'marketReviewLayout' }, { id: 'marketReviewQueue' },
    { id: 'marketReviewDetail' }, { id: 'marketReviewActions' },
  ],
  facets: [
    { id: 'packageType', attribute: 'data-openbitfun-package-type', values: ['native', 'imported'] },
  ],
  states: [
    { id: 'hover', selector: { kind: 'self', suffix: ':hover' } },
    { id: 'selected', selector: { kind: 'self', suffix: '[data-openbitfun-state~="selected"]' } },
    { id: 'disabled', selector: { kind: 'self', suffix: '[data-openbitfun-state~="disabled"]' } },
    { id: 'loading', selector: { kind: 'self', suffix: '[data-openbitfun-state~="loading"]' } },
  ],
};
