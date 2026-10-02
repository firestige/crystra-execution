import { inflateSync } from "node:zlib";
/** Accept only decoded-and-normalized, bounded PNG thumbnails, never arbitrary files. */
export function decodeThumbnail(encoded: string): Buffer {
  if (
    typeof encoded !== "string" ||
    encoded.length > 350000 ||
    !/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  )
    throw new Error("TASK_THUMBNAIL_INVALID");
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length > 256 * 1024 ||
    !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    throw new Error("TASK_THUMBNAIL_INVALID");
  let offset = 8,
    width = 0,
    height = 0,
    channels = 0,
    ended = false;
  const parts: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12)
      throw new Error("TASK_THUMBNAIL_INVALID");
    const type = bytes.toString("ascii", offset + 4, offset + 8),
      data = bytes.subarray(offset + 8, offset + 8 + length);
    let crc = 0xffffffff;
    for (const b of bytes.subarray(offset + 4, offset + 8 + length)) {
      crc ^= b;
      for (let n = 0; n < 8; n++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if ((crc ^ 0xffffffff) >>> 0 !== bytes.readUInt32BE(offset + 8 + length))
      throw new Error("TASK_THUMBNAIL_INVALID");
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13)
        throw new Error("TASK_THUMBNAIL_INVALID");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (
        !width ||
        !height ||
        width > 512 ||
        height > 512 ||
        data[8] !== 8 ||
        !channels ||
        data[10] ||
        data[11] ||
        data[12]
      )
        throw new Error("TASK_THUMBNAIL_INVALID");
    }
    if (type === "IDAT") parts.push(data);
    offset += length + 12;
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.length)
        throw new Error("TASK_THUMBNAIL_INVALID");
      ended = true;
      break;
    }
  }
  if (!ended || !channels || !parts.length)
    throw new Error("TASK_THUMBNAIL_INVALID");
  const row = width * channels + 1;
  const raw = inflateSync(Buffer.concat(parts), {
    maxOutputLength: 512 * 512 * 4 + 512,
  });
  if (raw.length !== row * height) throw new Error("TASK_THUMBNAIL_INVALID");
  for (let i = 0; i < height; i++)
    if (raw[i * row]! > 4) throw new Error("TASK_THUMBNAIL_INVALID");
  return bytes;
}
