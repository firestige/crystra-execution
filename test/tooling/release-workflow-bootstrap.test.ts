import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../..");

describe("release workflow bootstrap", () => {
  it("keeps candidate publication exclusive to release/next push", async () => {
    const [ci, candidate] = await Promise.all([
      readFile(path.join(repository, ".github/workflows/ci.yml"), "utf8"),
      readFile(path.join(repository, ".github/workflows/release-candidate.yml"), "utf8"),
    ]);

    expect(ci).not.toContain("release_candidate:");
    expect(ci).not.toContain("uses: ./.github/workflows/release-candidate.yml");
    expect(candidate).toContain("branches:\n      - release/next");
    expect(candidate).not.toContain("workflow_dispatch:");
    expect(candidate).not.toContain("workflow_call:");
    expect(candidate).toContain("release/request.json");
    expect(candidate).not.toContain("local_manual_e2e_evidence:");
  });

  it("qualifies and tags the current component commit without a superproject pin", async () => {
    const candidate = await readFile(path.join(repository, ".github/workflows/release-candidate.yml"), "utf8");
    expect(candidate).not.toContain("repository: firestige/crystra\n");
    expect(candidate).not.toContain("authority_ref");
    expect(candidate).not.toContain("submodules: recursive");
    expect(candidate).not.toContain("release-publisher");
    expect(candidate).toContain("RELEASE_TARGET: ${{ github.sha }}");
    expect(candidate).toContain('--target "$RELEASE_TARGET"');
    expect(candidate).toContain(".crystra-inputs/contracts/workflow-dsl-2-candidate ci");
    expect(candidate).toContain('pnpm release:artifacts "$RUNNER_TEMP/local-release"');
    expect(candidate).toContain("remoteArtifactVerification");
  });

  it("does not expose release inputs through ordinary CI", async () => {
    const ci = await readFile(path.join(repository, ".github/workflows/ci.yml"), "utf8");

    expect(ci).not.toContain("authority_manifest:");
    expect(ci).not.toContain("candidate_tag:");
  });

  it("scopes every GitHub Release operation to the component repository", async () => {
    const candidate = await readFile(path.join(repository, ".github/workflows/release-candidate.yml"), "utf8");
    const releaseCommands = candidate.split("\n").filter((line) => /gh release (?:view|create|download|upload)/u.test(line));

    expect(releaseCommands.length).toBeGreaterThan(0);
    expect(releaseCommands.every((line) => line.includes('--repo "$GITHUB_REPOSITORY"'))).toBe(true);
  });

  it("qualifies main and PRs using explicit component development inputs", async () => {
    const ci = await readFile(path.join(repository, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("- main");
    expect(ci).not.toContain("repository: firestige/crystra\n");
    expect(ci).not.toContain("submodules: recursive");
    expect(ci).toContain("config/development-inputs.json");
    expect(ci).toContain("path: .crystra-inputs/contracts");
    expect(ci).toContain("path: .crystra-inputs/workflow-package");
  });
});
