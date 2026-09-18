import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { c as createTar } from "tar";
import { LOCAL_WORKFLOW_SOURCE_KEY, parseLocalWorkflowIndex, type LocalWorkflowIndex } from "./local-workflow-source.js";
import { parseWorkflowSelector } from "./selector.js";

/** Packages a compiled Workflow locally; it never publishes or rewrites its semantic identity. */
export async function packLocalWorkflow(packageDirectory: string, indexFile: string) {
  const root = resolve(packageDirectory), index = resolve(indexFile), directory = dirname(index);
  const nested = relative(root, directory);
  if (nested === "" || (!nested.startsWith("..") && !isAbsolute(nested))) throw Error("LOCAL_SOURCE_MUST_BE_OUTSIDE_PACKAGE");
  const pkg = JSON.parse(await readFile(resolve(root, "definition/package.json"), "utf8"));
  if (typeof pkg.package?.name !== "string" || typeof pkg.package?.version !== "string") throw Error("INVALID_LOCAL_PACKAGE_IDENTITY");
  const selector = `${pkg.package?.name}@${pkg.package?.version}`;
  if (parseWorkflowSelector(selector).version.kind !== "EXACT") throw Error("WORKFLOW_EXACT_VERSION_REQUIRED");
  await mkdir(directory, { recursive: true });
  let catalog: LocalWorkflowIndex = { schemaVersion: "execution.local-workflow-source@1.0.0", packages: [] };
  try {
    if (!(await lstat(index)).isFile()) throw Error("LOCAL_SOURCE_INDEX_NOT_REGULAR");
    catalog = parseLocalWorkflowIndex(JSON.parse(await readFile(index, "utf8")));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temp = resolve(directory, `.archive-${randomUUID()}.tar.gz`);
  const tempIndex = resolve(directory, `.index-${randomUUID()}.json`);
  try {
    await createTar({ cwd: root, file: temp, gzip: true, portable: true, noMtime: true,
      filter: (name, stat) => !name.split("/").some(part => [".git", "node_modules"].includes(part)) && ("isSymbolicLink" in stat ? !stat.isSymbolicLink() : stat.type !== "SymbolicLink"),
    }, ["."]);
    const stat = await lstat(temp);
    if (stat.size > 134_217_728) throw Error("LOCAL_ARCHIVE_TOO_LARGE");
    const bytes = await readFile(temp), hash = createHash("sha256").update(bytes).digest("hex");
    const entry = { name: pkg.package.name as string, version: pkg.package.version as string, archive: `${hash}.tar.gz`, archiveDigest: `sha256:${hash}` };
    const existing = catalog.packages.find(item => item.name === entry.name && item.version === entry.version);
    if (existing && existing.archiveDigest !== entry.archiveDigest) throw Error("LOCAL_VERSION_ALREADY_EXISTS: use a new exact version after changes");
    await rename(temp, resolve(directory, entry.archive));
    if (!existing) {
      await writeFile(tempIndex, `${JSON.stringify({ ...catalog, packages: [...catalog.packages, entry] }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(tempIndex, index);
    }
    return { selector, archiveDigest: entry.archiveDigest, workflowSource: { kind: "adapter" as const, adapterKey: LOCAL_WORKFLOW_SOURCE_KEY, adapterConfigFile: index } };
  } finally {
    await rm(temp, { force: true });
    await rm(tempIndex, { force: true });
  }
}
