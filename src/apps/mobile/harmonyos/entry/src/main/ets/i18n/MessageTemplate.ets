// Substitute only slots in the original template. Callback results are literal:
// dollar signs and placeholder-like text in user data must never be re-parsed.
export function fillMessageTemplate(template: string, values: string[]): string {
  return template.replace(/%[12]\$s/g, (slot: string): string => {
    const index = slot === '%1$s' ? 0 : 1;
    return index < values.length ? values[index] : slot;
  });
}
