// foliate-js uses Object.groupBy / Map.groupBy (Safari 17.4+). Polyfill for older iOS.
type KeyFn<T, K> = (item: T, index: number) => K;

const O = Object as unknown as { groupBy?: unknown };
if (typeof O.groupBy !== 'function') {
  O.groupBy = <T>(items: Iterable<T>, fn: KeyFn<T, PropertyKey>) => {
    const out: Record<PropertyKey, T[]> = Object.create(null);
    let i = 0;
    for (const item of items) (out[fn(item, i++)] ??= []).push(item);
    return out;
  };
}
const M = Map as unknown as { groupBy?: unknown };
if (typeof M.groupBy !== 'function') {
  M.groupBy = <T, K>(items: Iterable<T>, fn: KeyFn<T, K>) => {
    const out = new Map<K, T[]>();
    let i = 0;
    for (const item of items) {
      const k = fn(item, i++);
      const arr = out.get(k);
      if (arr) arr.push(item);
      else out.set(k, [item]);
    }
    return out;
  };
}
