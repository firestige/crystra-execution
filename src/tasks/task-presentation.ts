import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  existsSync,
  renameSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { decodeThumbnail } from "./task-thumbnail.js";
export interface TaskPresentation {
  presentationRevision: number;
  displayTitle?: string;
  pinnedAt: number | null;
  archivedAt: number | null;
  thumbnailAssetId?: string;
  thumbnail?: string;
}
export interface UpdateTaskPresentation {
  taskId: string;
  expectedRevision: number;
  displayTitle?: string;
  pinned?: boolean;
  archived?: boolean;
  thumbnailPng?: string | null;
}
type Row = {
  task_id: string;
  revision: number;
  title: string | null;
  pinned_at: number | null;
  archived_at: number | null;
  thumbnail: string | null;
};
/** Ancillary resource metadata only; TaskRepository owns identity. SQLite CAS serializes worktree processes. */
export class TaskPresentationRepository {
  constructor(private readonly root: string) {}
  private open() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(join(this.root, "presentation.sqlite"));
    db.exec(
      "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS presentation (task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, title TEXT, pinned_at INTEGER, archived_at INTEGER, thumbnail TEXT)",
    );
    if (
      !db
        .prepare("PRAGMA table_info(presentation)")
        .all()
        .some((r) => r.name === "thumbnail")
    ) {
      try {
        db.exec("ALTER TABLE presentation ADD COLUMN thumbnail TEXT");
      } catch (error) {
        if (
          !db
            .prepare("PRAGMA table_info(presentation)")
            .all()
            .some((r) => r.name === "thumbnail")
        )
          throw error;
      }
    }
    return db;
  }
  private project(r: Row): TaskPresentation {
    return {
      presentationRevision: r.revision,
      ...(r.title === null ? {} : { displayTitle: r.title }),
      pinnedAt: r.pinned_at,
      archivedAt: r.archived_at,
      ...(r.thumbnail
        ? {
            thumbnailAssetId: r.thumbnail,
            thumbnail:
              "data:image/png;base64," +
              readFileSync(
                join(this.root, "presentation-assets", r.thumbnail + ".png"),
              ).toString("base64"),
          }
        : {}),
    };
  }
  list(): Map<string, TaskPresentation> {
    const path = join(this.root, "presentation.sqlite");
    if (!existsSync(path)) return new Map();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout=5000; BEGIN");
      const result = new Map(
        (db.prepare("SELECT * FROM presentation").all() as Row[]).map((r) => [
          r.task_id,
          this.project(r),
        ]),
      );
      db.exec("COMMIT");
      return result;
    } finally {
      db.close();
    }
  }
  update(input: UpdateTaskPresentation): TaskPresentation {
    if (
      !input ||
      typeof input.taskId !== "string" ||
      !input.taskId ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      Object.keys(input).some(
        (k) =>
          ![
            "taskId",
            "expectedRevision",
            "displayTitle",
            "pinned",
            "archived",
            "thumbnailPng",
          ].includes(k),
      ) ||
      !["displayTitle", "pinned", "archived", "thumbnailPng"].some(
        (k) => k in input,
      )
    )
      throw new Error("TASK_PRESENTATION_INVALID");
    if (
      input.displayTitle !== undefined &&
      (typeof input.displayTitle !== "string" ||
        !input.displayTitle.trim() ||
        input.displayTitle.trim().length > 120)
    )
      throw new Error("TASK_TITLE_INVALID");
    if (
      (input.pinned !== undefined && typeof input.pinned !== "boolean") ||
      (input.archived !== undefined && typeof input.archived !== "boolean")
    )
      throw new Error("TASK_PRESENTATION_INVALID");
    const image =
      input.thumbnailPng === undefined || input.thumbnailPng === null
        ? undefined
        : decodeThumbnail(input.thumbnailPng);
    const assets = join(this.root, "presentation-assets");
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = db
        .prepare("SELECT * FROM presentation WHERE task_id=?")
        .get(input.taskId) as Row | undefined;
      if ((row?.revision ?? 0) !== input.expectedRevision)
        throw new Error("TASK_PRESENTATION_CONFLICT");
      const title = input.displayTitle?.trim() ?? row?.title ?? null;
      const pinned =
        input.pinned === undefined
          ? (row?.pinned_at ?? null)
          : input.pinned
            ? (row?.pinned_at ?? Date.now())
            : null;
      const archived =
        input.archived === undefined
          ? (row?.archived_at ?? null)
          : input.archived
            ? (row?.archived_at ?? Date.now())
            : null;
      const revision = input.expectedRevision + 1;
      const thumbnail =
        input.thumbnailPng === undefined
          ? (row?.thumbnail ?? null)
          : image
            ? createHash("sha256").update(image).digest("hex")
            : null;
      if (image && thumbnail) {
        mkdirSync(assets, { recursive: true, mode: 0o700 });
        const temp = join(assets, randomUUID() + ".tmp");
        try {
          writeFileSync(temp, image, { flag: "wx", mode: 0o600, flush: true });
          renameSync(temp, join(assets, thumbnail + ".png"));
        } finally {
          if (existsSync(temp)) unlinkSync(temp);
        }
      }
      db.prepare(
        "INSERT INTO presentation VALUES (?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,title=excluded.title,pinned_at=excluded.pinned_at,archived_at=excluded.archived_at,thumbnail=excluded.thumbnail",
      ).run(input.taskId, revision, title, pinned, archived, thumbnail);
      const result = this.project({
        task_id: input.taskId,
        revision,
        title,
        pinned_at: pinned,
        archived_at: archived,
        thumbnail,
      });
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      db.close();
    }
  }
  /** Explicit safe cleanup after writes; all readers/writers hold a SQLite transaction. */
  collectAssets() {
    const db = this.open();
    try {
      db.exec("BEGIN EXCLUSIVE");
      const used = new Set(
        db
          .prepare(
            "SELECT thumbnail FROM presentation WHERE thumbnail IS NOT NULL",
          )
          .all()
          .map((r) => r.thumbnail),
      );
      let files: string[] = [];
      try {
        files = readdirSync(join(this.root, "presentation-assets"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const file of files)
        if (/^[a-f0-9]{64}\.png$/.test(file) && !used.has(file.slice(0, -4)))
          unlinkSync(join(this.root, "presentation-assets", file));
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  }
}
