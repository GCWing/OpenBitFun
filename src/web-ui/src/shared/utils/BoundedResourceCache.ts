/** Evicts only recomputable display resources, never authoritative session data. */
export class BoundedResourceCache<K, V> {
  private entries = new Map<K, { value: V; bytes: number }>();
  private bytes = 0;
  constructor(private maxBytes: number, private maxEntries = 128, private dispose?: (value: V) => void) {}
  get size() { return this.entries.size; }
  get byteSize() { return this.bytes; }
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  has(key: K) { return this.entries.has(key); }
  set(key: K, value: V, bytes = 1): this {
    this.delete(key);
    if (bytes > this.maxBytes) return this;
    this.entries.set(key, { value, bytes: Math.max(1, bytes) });
    this.bytes += Math.max(1, bytes);
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) this.delete(this.entries.keys().next().value!);
    return this;
  }
  delete(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    this.dispose?.(entry.value);
    return true;
  }
  clear() { for (const key of this.entries.keys()) this.delete(key); }
}
