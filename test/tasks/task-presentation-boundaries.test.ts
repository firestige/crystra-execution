import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { decodeThumbnail } from "../../src/tasks/task-thumbnail.js";
import { TaskPresentationRepository } from "../../src/tasks/task-presentation.js";

function chunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length);
  bytes.copy(output, 4);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}
const signature = Buffer.from("89504e470d0a1a0a", "hex");
function header(width = 1, height = 1): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 2;
  return chunk("IHDR", data);
}
const pixels = (bytes = [0, 255, 0, 0]) => chunk("IDAT", deflateSync(Buffer.from(bytes)));
const end = chunk("IEND", Buffer.alloc(0));

it("accepts bounded RGB thumbnails and rejects corrupt, oversized, or malformed PNGs", () => {
  const valid = Buffer.concat([signature, header(), pixels(), end]);
  expect(decodeThumbnail(valid.toString("base64"))).toEqual(valid);
  const badCrc = Buffer.from(valid);
  badCrc[29] = badCrc[29]! ^ 1;
  const truncatedChunk = Buffer.concat([signature, Buffer.alloc(12)]);
  truncatedChunk.writeUInt32BE(100, 8);
  for (const bytes of [
    Buffer.alloc(256 * 1024 + 1), badCrc, truncatedChunk,
    Buffer.concat([signature, header(513), pixels(), end]),
    Buffer.concat([signature, header(), header(), pixels(), end]),
    Buffer.concat([signature, header(), pixels(), end, Buffer.from([0])]),
    Buffer.concat([signature, header(), pixels(), chunk("IEND", Buffer.from([0]))]),
    Buffer.concat([signature, header(), pixels()]),
    Buffer.concat([signature, header(), end]),
    Buffer.concat([signature, header(), pixels([0]), end]),
    Buffer.concat([signature, header(), pixels([5, 255, 0, 0]), end]),
  ]) expect(() => decodeThumbnail(bytes.toString("base64"))).toThrow("TASK_THUMBNAIL_INVALID");
});

it("rejects malformed metadata updates before creating storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-metadata-boundary-"));
  try {
    const repository = new TaskPresentationRepository(root);
    for (const input of [
      { taskId: "t", expectedRevision: -1, pinned: true },
      { taskId: "t", expectedRevision: 0 },
      { taskId: "t", expectedRevision: 0, pinned: "yes" },
      { taskId: "t", expectedRevision: 0, archived: "yes" },
      { taskId: "t", expectedRevision: 0, pinned: true, extra: true },
    ]) expect(() => repository.update(input as never)).toThrow("TASK_PRESENTATION_INVALID");
    for (const displayTitle of ["   ", "x".repeat(121), 123]) {
      expect(() => repository.update({ taskId: "t", expectedRevision: 0, displayTitle } as never)).toThrow("TASK_TITLE_INVALID");
    }
    expect(repository.list().size).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("upgrades existing presentation metadata without losing title or revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-metadata-migration-"));
  try {
    const db = new DatabaseSync(join(root, "presentation.sqlite"));
    db.exec("CREATE TABLE presentation (task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, title TEXT, pinned_at INTEGER, archived_at INTEGER); INSERT INTO presentation VALUES ('t', 4, 'Existing', 123, NULL)");
    db.close();
    const repository = new TaskPresentationRepository(root);
    expect(repository.update({ taskId: "t", expectedRevision: 4, pinned: false })).toMatchObject({
      displayTitle: "Existing", presentationRevision: 5, pinnedAt: null,
    });
    repository.collectAssets();
    expect(new TaskPresentationRepository(root).list().get("t")).toMatchObject({ displayTitle: "Existing", presentationRevision: 5 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
