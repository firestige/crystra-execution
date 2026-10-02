import { readFile } from "node:fs/promises";
import type { ProviderModel } from "../provider.js";
import { resolveDshPublicClosure } from "./public-closure.js";

export async function queryDshModels(options: Readonly<{
  baseURL: string; credentialPath: string; credentialRef: string; timeoutMs: number;
}>): Promise<readonly ProviderModel[]> {
  // Resolve the supported optional peer without creating a runtime, realm or Session.
  const closure = await resolveDshPublicClosure();
  const key = process.env[options.credentialRef] || closure.parseCredentialsDocument(
    await readFile(options.credentialPath, "utf8"), options.credentialPath,
  ).refs.get(options.credentialRef);
  if (!key) throw new TypeError("DSH credential is unavailable");
  const endpoint = new URL(options.baseURL);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, "")}/models`;
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    redirect: "error", signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new TypeError("DSH model catalog request failed");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > 1024 * 1024) throw new TypeError("DSH model catalog exceeds limit");
    chunks.push(chunk);
  }
  const document: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const data = (document as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length > 1000) throw new TypeError("DSH model catalog is invalid");
  const seen = new Set<string>();
  return Object.freeze(data.map((entry: unknown) => {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !id.trim() || id !== id.trim() || seen.has(id)) {
      throw new TypeError("DSH model catalog entry is invalid");
    }
    seen.add(id);
    return Object.freeze({ provider: "deepseek", model: id });
  }));
}
