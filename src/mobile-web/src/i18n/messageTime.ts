/** Read legacy numeric timestamps as well as ISO strings without inventing missing times. */
export function messageTimestamp(value: string | undefined): Date | null {
  const text = value?.trim();
  if (!text) return null;
  let milliseconds: number;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const number = Number(text);
    milliseconds = number < 1e11 ? number * 1000 : number < 1e14 ? number : number < 1e17 ? number / 1000 : number / 1e6;
  } else {
    milliseconds = Date.parse(text.replace(' ', 'T'));
  }
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date : null;
}
