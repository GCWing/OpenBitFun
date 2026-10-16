export function reportRows(report, workspaceCounts, text) {
  return report.domainResults.flatMap((result) => {
    const transferred = result.state === 'verified' ? text.imported : text.staged;
    const warnings = result.warnings.filter((item) => item.severity !== 'info');
    const rows = result.domain === 'workspace_sessions'
      ? [
        ['sessions', text.sessions],
        ['workspaces', text.workspaces],
        ['assistantDirectories', text.assistantDirectories],
      ].map(([key, label]) => {
        const counts = workspaceCounts?.[key];
        return [label, counts
          ? `${counts.imported} ${transferred}, ${counts.skipped} ${text.skipped}`
          : text.itemCountsUnavailable];
      })
      : [[result.domain, `${result.imported} ${transferred}, ${result.skipped} ${text.skipped}, ${warnings.length} ${text.warnings}`]];
    rows.push(...[...new Set(warnings.map((item) => item.code))]
      .map((code) => [result.domain, text[code] || code]));
    return rows;
  });
}
