import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, open, link, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface TaskHeader {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
}
export interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt?: number;
  readonly lastActivityAt: number;
  readonly deliveryIds: readonly string[];
}
export interface TaskSnapshot {
  readonly schemaVersion: "execution.tasks@1.0.0";
  readonly revision: string;
  readonly items: readonly TaskSummary[];
}
export interface TaskManifest {
  readonly taskId: string;
  readonly taskDisplayName?: string;
  readonly deliveryId: string;
  readonly createdAt: number;
}
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function validate(value: TaskHeader): void {
  if (
    !value ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.title !== "string" ||
    !value.title ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0
  )
    throw new Error("TASK_RECORD_INVALID");
}
/** Execution-owned Task identity metadata. Creation survives a failed Delivery launch.
 * Atomic no-overwrite publication protects identities across worktrees/processes.
 */
export class TaskRepository {
  constructor(readonly root: string) {
    if (!isAbsolute(root)) throw new Error("TASK_ROOT_INVALID");
  }
  async create(header: TaskHeader): Promise<void> {
    validate(header);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const destination = join(this.root, digest(header.id) + ".json");
    const temporary = destination + "." + randomUUID() + ".candidate";
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ schemaVersion: "execution.task@1.0.0", ...header }) +
          "\n",
      );
      await handle.sync();
      await handle.close();
      await link(temporary, destination);
      const directory = await open(this.root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await handle.close();
      await unlink(temporary).catch(() => undefined);
    }
  }
  /** Retry-safe owner command. The caller supplies a stable admission identity. */
  async admit(header: TaskHeader): Promise<TaskHeader> {
    validate(header);
    try { await this.create(header); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = (await this.list()).find(item => item.id === header.id);
      if (!existing || existing.title !== header.title || existing.createdAt !== header.createdAt)
        throw new Error("TASK_ADMISSION_CONFLICT");
      return existing;
    }
    return Object.freeze({...header});
  }
  async list(): Promise<readonly TaskHeader[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map(async (name) => {
          const value = JSON.parse(
            await readFile(join(this.root, name), "utf8"),
          );
          validate(value);
          if (
            value.schemaVersion !== "execution.task@1.0.0" ||
            name !== digest(value.id) + ".json" ||
            Object.keys(value).sort().join(",") !==
              "createdAt,id,schemaVersion,title"
          )
            throw new Error("TASK_RECORD_INVALID");
          return Object.freeze({
            id: value.id as string,
            title: value.title as string,
            createdAt: value.createdAt as number,
          });
        }),
    );
  }
}
/** Lists cold Tasks without starting runtimes. Manifest references are compatibility
 * facts, never a source of Task lifecycle or inferred Task creation timestamps.
 */
export class TaskQuery {
  constructor(
    private readonly repository: TaskRepository,
    private readonly manifests: () => Promise<readonly TaskManifest[]>,
  ) {}
  async snapshot(): Promise<TaskSnapshot> {
    const [headers, manifests] = await Promise.all([
      this.repository.list(),
      this.manifests(),
    ]);
    const owned = new Set(headers.map((h) => h.id));
    const tasks = new Map<
      string,
      {
        id: string;
        title: string;
        createdAt?: number;
        lastActivityAt: number;
        deliveryIds: string[];
      }
    >();
    for (const header of headers)
      tasks.set(header.id, {
        ...header,
        lastActivityAt: header.createdAt,
        deliveryIds: [],
      });
    for (const manifest of [...manifests].sort(
      (a, b) =>
        a.createdAt - b.createdAt || a.deliveryId.localeCompare(b.deliveryId),
    )) {
      let task = tasks.get(manifest.taskId);
      if (!task) {
        task = {
          id: manifest.taskId,
          title: manifest.taskDisplayName || manifest.taskId,
          lastActivityAt: manifest.createdAt,
          deliveryIds: [],
        };
        tasks.set(task.id, task);
      }
      if (!owned.has(task.id) && manifest.taskDisplayName)
        task.title = manifest.taskDisplayName;
      task.lastActivityAt = Math.max(task.lastActivityAt, manifest.createdAt);
      if (!task.deliveryIds.includes(manifest.deliveryId))
        task.deliveryIds.push(manifest.deliveryId);
    }
    const items = Object.freeze(
      [...tasks.values()]
        .sort(
          (a, b) =>
            b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id),
        )
        .map((t) =>
          Object.freeze({
            ...t,
            deliveryIds: Object.freeze(t.deliveryIds.sort()),
          }),
        ),
    );
    return Object.freeze({
      schemaVersion: "execution.tasks@1.0.0",
      revision: digest(JSON.stringify(items)),
      items,
    });
  }
}
