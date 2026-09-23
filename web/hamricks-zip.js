// SheetJS's ZIP reader trusts directory offsets. Reject incomplete containers
// before it can seek outside the buffer or enter its inflater with missing data.
export function prepareWorkbookZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = () => { throw new Error("Incomplete or invalid workbook ZIP."); };
  const u16 = (offset) => view.getUint16(offset, true);
  const u32 = (offset) => view.getUint32(offset, true);
  let end = bytes.length - 22;
  const earliest = Math.max(0, end - 65535);
  for (; end >= earliest; end--) {
    if (u32(end) === 0x06054B50 && end + 22 + u16(end + 20) === bytes.length) break;
  }
  if (end < earliest) invalid();
  const count = u16(end + 10), size = u32(end + 12), start = u32(end + 16);
  // Multi-volume archives and ZIP64 directories are not supported by the reader.
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count || !count ||
      start + size !== end || count > size / 46) invalid();
  let cursor = start;
  const storedSizes = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014B50) invalid();
    const nameSize = u16(cursor + 28), extraSize = u16(cursor + 30), commentSize = u16(cursor + 32);
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    const local = u32(cursor + 42);
    let compressed = u32(cursor + 20);
    if (next > end || u16(cursor + 34) || local + 30 > start || u32(local) !== 0x04034B50) invalid();
    // Some writers use a ZIP64 size field even for small individual entries.
    if (compressed === 0xFFFFFFFF) {
      let extra = cursor + 46 + nameSize;
      const extraEnd = extra + extraSize;
      for (; extra + 4 <= extraEnd; extra += 4 + u16(extra + 2)) {
        const length = u16(extra + 2);
        if (extra + 4 + length > extraEnd) invalid();
        if (u16(extra) !== 1) continue;
        const offset = extra + 4 + (u32(cursor + 24) === 0xFFFFFFFF ? 8 : 0);
        if (offset + 8 > extra + 4 + length) invalid();
        const value = view.getBigUint64(offset, true);
        if (value > BigInt(bytes.length)) invalid();
        compressed = Number(value);
        break;
      }
    }
    const dataStart = local + 30 + u16(local + 26) + u16(local + 28);
    if (dataStart + compressed > start || u16(local + 26) !== nameSize) invalid();
    const localSize = u32(local + 18), streamed = !!(u16(local + 6) & 8);
    if (!streamed && localSize !== 0xFFFFFFFF && localSize !== compressed) invalid();
    if (streamed && u16(local + 8) === 0) {
      // The bundled reader needs stored-entry sizes in the local header, even
      // though streaming ZIP writers legitimately put them only in a descriptor.
      let descriptor = dataStart + compressed;
      if (descriptor + 12 > start) invalid();
      if (u32(descriptor) === 0x08074B50) descriptor += 4;
      if (descriptor + 12 > start || u32(descriptor + 4) !== compressed ||
          u32(descriptor + 8) !== compressed || u32(cursor + 24) !== compressed) invalid();
      if (localSize !== compressed) storedSizes.push([local, compressed]);
    }
    for (let j = 0; j < nameSize; j++) {
      if (bytes[local + 30 + j] !== bytes[cursor + 46 + j]) invalid();
    }
    cursor = next;
  }
  if (cursor !== end) invalid();
  if (!storedSizes.length && end + 22 === bytes.length) return bytes;
  // Work on a copy. Removing comments also prevents an embedded ZIP signature
  // in a comment from confusing the reader's backwards directory search.
  const prepared = new Uint8Array(bytes.subarray(0, end + 22)), output = new DataView(prepared.buffer);
  output.setUint16(end + 20, 0, true);
  for (const [local, size] of storedSizes) {
    output.setUint32(local + 18, size, true);
    output.setUint32(local + 22, size, true);
  }
  return prepared;
}
