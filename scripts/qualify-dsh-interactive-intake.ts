import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";


const require = createRequire(import.meta.url);

export function dshExecutable(): string {
  const manifestPath = require.resolve("@deepseek-ai/dsh/package.json");
  const manifest = require(manifestPath) as { readonly bin?: { readonly dsh?: string } };
  if (manifest.bin?.dsh === undefined) throw new TypeError("DSH_EXECUTABLE_UNAVAILABLE");
  return path.resolve(path.dirname(manifestPath), manifest.bin.dsh);
}

export function runDsh(dshHome: string, cwd: string, args: readonly string[]): string {
  return execFileSync(process.execPath, [dshExecutable(), ...args], {
    cwd,
    env: { ...process.env, DSH_HOME: dshHome },
    encoding: "utf8",
    stdio: "pipe",
  });
}

export async function waitForWebUrl(child: ChildProcess): Promise<URL> {
  return await new Promise<URL>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`DSH_WEB_START_TIMEOUT:${output.slice(-2_000)}`)), 30_000);
    const inspect = (chunk: Buffer | string) => {
      output += chunk.toString();
      const match = output.match(/dsh web:\s+(http:\/\/[^\s]+)/u);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(new URL(match[1]));
      }
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`DSH_WEB_EXITED:${String(code)}:${output.slice(-10_000)}`));
    });
  });
}

export async function rpc(url: URL, method: string, payload: unknown): Promise<any> {
  const rpcId = `qualification-${method}`;
  const response = await fetch(new URL(`/api/${method}`, url), {
    method: "POST",
    headers: { "content-type": "application/json", origin: url.origin },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
  });
  if (response.status !== 200) throw new Error(`DSH_RPC_HTTP_${String(response.status)}`);
  const body = await response.json() as any;
  if (body.type !== "server-response" || body.rpcId !== rpcId) throw new Error("DSH_RPC_RESPONSE_INVALID");
  return body.result;
}

export interface CdpConnection {
  readonly events: unknown[];
  call(method: string, params?: Readonly<Record<string, unknown>>): Promise<any>;
  close(): void;
}

async function connectCdp(url: string): Promise<CdpConnection> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CHROME_CDP_CONNECT_FAILED")), { once: true });
  });
  let sequence = 0;
  const events: unknown[] = [];
  const pending = new Map<number, { resolve(value: unknown): void; reject(cause: unknown): void }>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { readonly id?: number; readonly result?: unknown; readonly error?: unknown };
    if (message.id === undefined) {
      if (events.length >= 100) events.shift();
      events.push(message);
      return;
    }
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error === undefined) waiter.resolve(message.result);
    else waiter.reject(new Error(`CHROME_CDP_ERROR:${JSON.stringify(message.error)}`));
  });
  return Object.freeze({
    events,
    call(method: string, params: Readonly<Record<string, unknown>> = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  });
}

function chromeExecutable(): string {
  if (process.env.CRYSTRA_CHROME_PATH !== undefined) return path.resolve(process.env.CRYSTRA_CHROME_PATH);
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return "google-chrome";
}

export async function waitFor<T>(read: () => Promise<T | undefined>, code: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(code);
}

export async function launchBrowser(root: string, url: URL): Promise<Readonly<{ child: ChildProcess; cdp: CdpConnection }>> {
  const profile = path.join(root, "chrome-profile");
  await mkdir(profile, { recursive: true });
  // A reused browser profile retains this file after Chrome exits. Remove the
  // stale port before relaunch so readiness cannot resolve to the dead process.
  await rm(path.join(profile, "DevToolsActivePort"), { force: true });
  const child = spawn(chromeExecutable(), [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const port = await waitFor(async () => {
    try {
      const [line] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n");
      return line === undefined || !/^\d+$/u.test(line) ? undefined : Number(line);
    } catch { return undefined; }
  }, "CHROME_DEVTOOLS_PORT_UNAVAILABLE");
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  if (!target.ok) throw new Error(`CHROME_TARGET_FAILED:${String(target.status)}`);
  const descriptor = await target.json() as { readonly webSocketDebuggerUrl?: string };
  if (descriptor.webSocketDebuggerUrl === undefined) throw new Error("CHROME_TARGET_INVALID");
  const cdp = await connectCdp(descriptor.webSocketDebuggerUrl);
  await Promise.all([cdp.call("Page.enable"), cdp.call("Runtime.enable"), cdp.call("Log.enable")]);
  await cdp.call("Page.navigate", { url: url.href });
  await waitFor(async () => {
    const response = await cdp.call("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }) as any;
    return response.result?.value === "complete" ? true : undefined;
  }, "DSH_BROWSER_PAGE_TIMEOUT");
  return Object.freeze({ child, cdp });
}

export async function evaluate(cdp: CdpConnection, expression: string): Promise<any> {
  const response = await cdp.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }) as any;
  if (response.exceptionDetails !== undefined) throw new Error(`DSH_BROWSER_EVALUATION_FAILED:${JSON.stringify(response.exceptionDetails)}`);
  return response.result?.value;
}

export function isBlockingPromptDismissalLabel(label: string): boolean {
  return /^(继续|Continue|稍后配置|Configure later|Later|Skip for now)$/u.test(label.trim());
}

export function isWorkspacePickerLabel(label: string): boolean {
  return /^(选择工作区|Choose workspace|Select workspace)$/u.test(label.trim());
}

export async function dismissBlockingPrompts(cdp: CdpConnection): Promise<void> {
  await waitFor(async () => {
    const ready = await evaluate(cdp, `(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) =>
        (${isBlockingPromptDismissalLabel.toString()})(candidate.textContent ?? ''));
      if (button) { button.click(); return false; }
      return document.querySelector('#root')?.hasAttribute('inert') === false;
    })()`);
    return ready === true ? true : undefined;
  }, "DSH_BROWSER_BLOCKING_PROMPT_UNAVAILABLE");
}

export async function submitBrowserCommand(cdp: CdpConnection, line: string): Promise<void> {
  /* v8 ignore next -- real Chrome qualification covers asynchronous onboarding dismissal before submission. */
  await dismissBlockingPrompts(cdp);
  await waitFor(async () => await evaluate(cdp, `(() => {
    const input = [...document.querySelectorAll('textarea,[contenteditable="true"]')].findLast((candidate) => {
      if (!(candidate instanceof HTMLElement) || candidate.getClientRects().length === 0) return false;
      const style = window.getComputedStyle(candidate);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (candidate instanceof HTMLTextAreaElement && (candidate.disabled || candidate.readOnly)) return false;
      return candidate.getAttribute('aria-disabled') !== 'true';
    });
    if (!input) return false;
    input.focus();
    return true;
  })()`) === true ? true : undefined, "DSH_BROWSER_COMPOSER_UNAVAILABLE", 120_000);
  await cdp.call("Input.insertText", { text: line });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

/** Retired private-fixture entry point. Product browser qualification belongs to crystra-dsh. */
export async function qualifyDshInteractiveIntake(_input: Readonly<{
  coreArchive: string;
  pluginArchive: string;
  worktree?: string;
}>): Promise<never> {
  throw new Error("DSH_PRIVATE_INTAKE_QUALIFICATION_RETIRED: qualify the public dsh-crystra host in crystra-dsh");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [coreArchive, pluginArchive, worktree] = process.argv.slice(2);
  if (coreArchive === undefined || pluginArchive === undefined) throw new TypeError("DSH_INTERACTIVE_QUALIFICATION_USAGE_INVALID");
  process.stdout.write(`${JSON.stringify(await qualifyDshInteractiveIntake({ coreArchive, pluginArchive, worktree }))}\n`);
}
