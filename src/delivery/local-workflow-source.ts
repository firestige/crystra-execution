import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { WorkflowPackageSource, WorkflowPackageSourceRequest, WorkflowPackageSourceResult } from "../bootstrap/runtime-contracts.js";
import { parseWorkflowSelector } from "./selector.js";

export const LOCAL_WORKFLOW_SOURCE_KEY = "workflow.local.v1";
export interface LocalWorkflowEntry {
  readonly name: string;
  readonly version: string;
  readonly archive: string;
  readonly archiveDigest: string;
}
export interface LocalWorkflowIndex {
  readonly schemaVersion: "execution.local-workflow-source@1.0.0";
  readonly packages: readonly LocalWorkflowEntry[];
}
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function regularFile(file: string, limit: number): Promise<Buffer> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > limit) throw Error("Invalid local source file");
  const bytes = await readFile(file);
  if (bytes.length > limit) throw Error("Local source file exceeds limit");
  return bytes;
}
export function parseLocalWorkflowIndex(value: unknown): LocalWorkflowIndex {
  const index = value as LocalWorkflowIndex;
  if (!index || Object.keys(index).sort().join() !== "packages,schemaVersion"
    || index.schemaVersion !== "execution.local-workflow-source@1.0.0" || !Array.isArray(index.packages)) throw Error("Invalid local source index");
  const seen = new Set<string>();
  for (const entry of index.packages) {
    if (!entry || Object.keys(entry).sort().join() !== "archive,archiveDigest,name,version"
      || typeof entry.name !== "string" || typeof entry.version !== "string"
      || typeof entry.archive !== "string" || entry.archive.length === 0
      || isAbsolute(entry.archive) || entry.archive.includes(":") || entry.archive.includes("\\")
      || entry.archive.split("/").some((part: string) => part === ".." || part === "")
      || typeof entry.archiveDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(entry.archiveDigest)) throw Error("Invalid local package entry");
    const coordinate = `${entry.name}@${entry.version}`;
    if (parseWorkflowSelector(coordinate).version.kind !== "EXACT" || seen.has(coordinate)) throw Error("Exact unique local version required");
    seen.add(coordinate);
  }
  return index;
}

/** Private, explicit local catalog. No network fallback and no mutable latest alias. */
export class LocalWorkflowPackageSource implements WorkflowPackageSource {
  readonly selectionPolicy = "exact-private" as const;
  readonly cacheNamespace: string;
  constructor(readonly configurationFile: string) {
    if (!isAbsolute(configurationFile)) throw Error("Local source index must be absolute");
    this.cacheNamespace = createHash("sha256").update(resolve(configurationFile)).digest("hex");
  }
  async fetch(request: WorkflowPackageSourceRequest): Promise<WorkflowPackageSourceResult> {
    if (request.version.kind !== "EXACT") return { kind: "INVALID" };
    try {
      const index = parseLocalWorkflowIndex(JSON.parse((await regularFile(this.configurationFile, 1_048_576)).toString("utf8")));
      const selected = index.packages.find(entry => entry.name === request.name && entry.version === (request.version as { value: string }).value);
      if (!selected) return { kind: "NOT_FOUND" };
      const root = await realpath(dirname(this.configurationFile));
      const archivePath = resolve(root, selected.archive);
      const actualPath = await realpath(archivePath);
      const rel = relative(root, actualPath);
      if (rel.startsWith("..") || isAbsolute(rel) || actualPath !== archivePath) return { kind: "INVALID" };
      const archive = await regularFile(archivePath, 134_217_728);
      if (digest(archive) !== selected.archiveDigest) return { kind: "DIGEST_MISMATCH" };
      return { kind: "FOUND", candidate: { name: selected.name, exactVersion: selected.version, archiveDigest: selected.archiveDigest, archive } };
    } catch (error) {
      return { kind: (error as NodeJS.ErrnoException).code === "ENOENT" ? "NOT_FOUND" : "INVALID" };
    }
  }
}
