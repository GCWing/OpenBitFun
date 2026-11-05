import { validateGenUISchema, type GenUIContractIssue } from './genUIContract';
import type { GenUIAppDefinition, GenUIAppState } from './genUITypes';
export function validateGenUIState(app: GenUIAppDefinition, state: unknown): GenUIContractIssue[] {
  const issues = validateGenUISchema(state, { type: 'object' }, 'app_state');
  if (issues.length)
    return issues;
  if (app.schemaVersion !== 2 || !app.state)
    return [{ path: 'app', code: 'version', severity: 'error', message: 'Unsupported application version; original data retained' }];
  for (const [key, declaration] of Object.entries(app.state))
    if (Object.prototype.hasOwnProperty.call(state as object, key))
      issues.push(...validateGenUISchema((state as GenUIAppState)[key], { type: declaration.type }, 'app_state.' + key));
  return issues;
}
export function genUIContentKey(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
}
/** Defaults may change during generation; user and persisted values always win. */
export class GenUIStateStore {
  private values: GenUIAppState = {};
  private pristine = new Set<string>();
  initialize(app: GenUIAppDefinition, persisted?: GenUIAppState) {
    const next = { ...this.values, ...persisted };
    for (const key of Object.keys(persisted ?? {}))
      this.pristine.delete(key);
    for (const [key, declaration] of Object.entries(app.state ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(next, key) || this.pristine.has(key)) {
        next[key] = structuredClone(declaration.default);
        this.pristine.add(key);
      }
    }
    this.values = next;
    return next;
  }
  get() { return this.values; }
  commit(next: GenUIAppState) {
    for (const key of Object.keys(next))
      if (genUIContentKey(next[key]) !== genUIContentKey(this.values[key]))
        this.pristine.delete(key);
    this.values = next;
  }
}
