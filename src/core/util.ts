/** Append to a list inside a map, creating it if needed (O(1); spreading arrays here was O(n²) on big columns). */
export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
