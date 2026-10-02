import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TaskRepository, TaskQuery } from "../../src/tasks/task-query.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "execution-tasks-"));
  roots.push(root);
  return new TaskRepository(root);
}
it("lists a durable Task without a Delivery or a runtime, including after reopening", async () => {
  const store = await repository();
  await store.create({ id: "t1", title: "Task one", createdAt: 10 });
  const query = new TaskQuery(new TaskRepository(store.root), async () => []);
  const snapshot = await query.snapshot();
  expect(snapshot.items).toEqual([
    {
      id: "t1",
      title: "Task one",
      createdAt: 10,
      lastActivityAt: 10,
      deliveryIds: [],
    },
  ]);
  expect((await query.snapshot()).revision).toBe(snapshot.revision);
  await expect(
    store.create({ id: "t1", title: "overwrite", createdAt: 11 }),
  ).rejects.toThrow();
});
it("merges legacy manifests by task identity while Task metadata remains authoritative", async () => {
  const store = await repository();
  await store.create({ id: "t1", title: "Task owner", createdAt: 1 });
  const query = new TaskQuery(store, async () => [
    {
      taskId: "t1",
      taskDisplayName: "delivery alias",
      deliveryId: "d1",
      createdAt: 2,
    },
    {
      taskId: "old",
      taskDisplayName: "Legacy",
      deliveryId: "d2",
      createdAt: 3,
    },
    { taskId: "old", deliveryId: "d3", createdAt: 4 },
  ]);
  const { items } = await query.snapshot();
  expect(items.find((t) => t.id === "t1")).toMatchObject({
    title: "Task owner",
    createdAt: 1,
    deliveryIds: ["d1"],
  });
  expect(items.find((t) => t.id === "old")).toEqual({
    id: "old",
    title: "Legacy",
    lastActivityAt: 4,
    deliveryIds: ["d2", "d3"],
  });
});
it("surfaces source failures instead of serving a partial catalogue", async () => {
  const query = new TaskQuery(await repository(), async () => {
    throw Error("corrupt manifest");
  });
  await expect(query.snapshot()).rejects.toThrow("corrupt manifest");
});
it('admits once across concurrent retries and rejects identity reuse with different facts', async () => {
 const store=await repository(), header={id:'admission-1',title:'First user input',createdAt:12};
 await Promise.all([store.admit(header),new TaskRepository(store.root).admit(header)]);
 expect(await store.list()).toEqual([header]);
 await expect(store.admit({...header,title:'Different task'})).rejects.toThrow('TASK_ADMISSION_CONFLICT');
});

it("distinguishes a never-created Task store from an unreadable store", async () => {
  const { writeFile } = await import("node:fs/promises");
  const store = await repository();
  expect(await new TaskRepository(join(store.root, "absent")).list()).toEqual([]);
  const file = join(store.root, "not-a-directory");
  await writeFile(file, "not a Task store");
  await expect(new TaskRepository(file).list()).rejects.toMatchObject({ code: "ENOTDIR" });
});

it("rejects invalid admission facts and misnamed durable Task records", async () => {
  const { writeFile } = await import("node:fs/promises");
  const store = await repository();
  await expect(store.admit({ id: "t", title: "", createdAt: 0 })).rejects.toThrow("TASK_RECORD_INVALID");
  await writeFile(join(store.root, "wrong-identity.json"), JSON.stringify({ schemaVersion: "execution.task@1.0.0", id: "t", title: "Title", createdAt: 1 }));
  await expect(new TaskQuery(store, async () => []).snapshot()).rejects.toThrow("TASK_RECORD_INVALID");
});
