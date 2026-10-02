import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDshAgentProviderFactory } from "../../../src/providers/dsh/agent-provider.js";
import { AgentProviderFactoryRegistry } from "../../../src/providers/provider.js";

describe("DSH endpoint model catalog", () => {
  it.each(["environment", "file", "missing", "denied", "invalid", "bad-entry", "duplicate", "empty", "timeout", "redirect", "oversized"])("queries exact configured endpoint without a realm: %s", async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "dsh-models-"));
    const requests: Array<{url?: string; authorization?: string}> = [];
    const server = createServer((request, response) => {
      requests.push({url:request.url,authorization:request.headers.authorization});
      if(scenario === "timeout") return;
      if(scenario === "redirect") { response.writeHead(302,{location:"/unexpected"});response.end();return; }
      if(scenario === "denied") { response.writeHead(401);response.end("secret must never leak");return; }
      response.setHeader("content-type", "application/json");
      const data = scenario === "empty" ? [] : scenario === "bad-entry" ? [{id:" "}] : scenario === "duplicate" ? [{id:"local-deepseek"},{id:"local-deepseek"}] : [{id:"local-deepseek"},{id:"reasoner-v2"}];
      response.end(scenario === "oversized" ? ' '.repeat(1024*1024+1) : JSON.stringify(scenario === "invalid" ? {error:"secret must never leak"} : {data}));
    });
    const previous = process.env.CRYSTRA_MODEL_QUERY_TEST_KEY;
    try {
      await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
      const address=server.address();if(!address||typeof address==='string') throw Error('test port missing');
      const credentialPath=join(root,"credentials.yml");
      if(scenario !== "missing") await writeFile(credentialPath,"version: 1\nrefs:\n  CRYSTRA_MODEL_QUERY_TEST_KEY: file-key\n");
      if(scenario === "environment") process.env.CRYSTRA_MODEL_QUERY_TEST_KEY="environment-key";
      else delete process.env.CRYSTRA_MODEL_QUERY_TEST_KEY;
      const factory=createDshAgentProviderFactory({stateDirectory:join(root,"state"),credentialPath,credentialRef:"CRYSTRA_MODEL_QUERY_TEST_KEY",baseURL:`http://127.0.0.1:${address.port}/v1/`,modelQueryTimeoutMs:scenario==='timeout'?30:5000});
      const [entry]=await new AgentProviderFactoryRegistry([factory]).modelCatalog();
      if(["environment","file","empty"].includes(scenario)) {
        expect(entry!.modelCatalog).toEqual({state:"available",models:scenario==='empty'?[]:[{provider:"deepseek",model:"local-deepseek"},{provider:"deepseek",model:"reasoner-v2"}]});
      } else {
        expect(entry!.modelCatalog).toEqual({state:"unavailable",models:[],error:"PROVIDER_MODEL_QUERY_FAILED"});
      }
      expect(requests).toEqual(scenario==='missing'?[]:[{url:"/v1/models",authorization:`Bearer ${scenario==='environment'?'environment-key':'file-key'}`}]);
      await expect(readFile(join(root,"state"))).rejects.toMatchObject({code:"ENOENT"});
    } finally {
      if(previous === undefined) delete process.env.CRYSTRA_MODEL_QUERY_TEST_KEY; else process.env.CRYSTRA_MODEL_QUERY_TEST_KEY=previous;
      server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
      await rm(root,{recursive:true,force:true});
    }
  });
});
