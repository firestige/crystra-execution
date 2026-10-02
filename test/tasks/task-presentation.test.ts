import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TaskQuery, TaskRepository } from "../../src/tasks/task-query.js";
it("persists presentation independently of identity and rejects stale updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-presentation-"));
  try {
    const repo = new TaskRepository(root);
    await repo.create({ id: "t", title: "Original", createdAt: 10 });
    const q = new TaskQuery(repo, async () => []);
    await q.updatePresentation({
      taskId: "t",
      expectedRevision: 0,
      displayTitle: " Renamed ",
      pinned: true,
    });
    const reloaded = new TaskQuery(new TaskRepository(root), async () => []);
    const item = (await reloaded.snapshot()).items[0]!;
    expect(item.title).toBe("Renamed");
    expect(item.lastActivityAt).toBe(10);
    expect(item.presentationRevision).toBe(1);
    expect(item.pinnedAt).toBeGreaterThan(0);
    expect((await repo.list())[0]!.title).toBe("Original");
    await expect(
      q.updatePresentation({
        taskId: "t",
        expectedRevision: 0,
        displayTitle: "stale",
      }),
    ).rejects.toThrow("TASK_PRESENTATION_CONFLICT");
    await q.updatePresentation({
      taskId: "t",
      expectedRevision: 1,
      archived: true,
    });
    expect((await q.snapshot()).items[0]!.archivedAt).toBeGreaterThan(0);
    await q.updatePresentation({
      taskId: "t",
      expectedRevision: 2,
      archived: false,
    });
    expect((await q.snapshot()).items[0]!.archivedAt).toBeNull();
    await expect(
      q.updatePresentation({
        taskId: "unknown",
        expectedRevision: 0,
        pinned: true,
      }),
    ).rejects.toThrow("TASK_NOT_FOUND");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("validates normalized thumbnails, persists assets, clears them and protects conflicts", async () => {
  const { deflateSync } = await import("node:zlib");
  const { readdir } = await import("node:fs/promises");
  function chunk(type: string, data: Buffer) {
    const t = Buffer.from(type);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([t, data])) {
      crc ^= byte;
      for (let n = 0; n < 8; n++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    t.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
    return out;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
  const root = await mkdtemp(join(tmpdir(), "thumbnail-"));
  try {
    const repo = new TaskRepository(root);
    await repo.create({ id: "t", title: "Original", createdAt: 10 });
    const q = new TaskQuery(repo, async () => []);
    await expect(
      q.updatePresentation({
        taskId: "t",
        expectedRevision: 0,
        thumbnailPng: "bad",
      }),
    ).rejects.toThrow();
    await q.updatePresentation({
      taskId: "t",
      expectedRevision: 0,
      thumbnailPng: png,
    });
    expect((await q.snapshot()).items[0]!.thumbnail).toBe(
      "data:image/png;base64," + png,
    );
    await expect(
      q.updatePresentation({
        taskId: "t",
        expectedRevision: 0,
        thumbnailPng: null,
      }),
    ).rejects.toThrow("CONFLICT");
    expect((await readdir(join(root, "presentation-assets"))).length).toBe(1);
    await q.updatePresentation({
      taskId: "t",
      expectedRevision: 1,
      thumbnailPng: null,
    });
    expect((await q.snapshot()).items[0]!.thumbnail).toBeUndefined();
    expect(await readdir(join(root, "presentation-assets"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("keeps cold task reads free of metadata files", async () => {
  const { readdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "task-readonly-"));
  try {
    const repo = new TaskRepository(root);
    await repo.create({ id: "read-only", title: "Original", createdAt: 1 });
    const before = await readdir(root);
    await new TaskQuery(repo, async () => []).snapshot();
    expect(await readdir(root)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
