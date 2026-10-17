import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { loadSummaryConfig, summarizeTurn } from "../src/summary.js";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it("summarizes a real Pi 1.2 session through its registry with a local faux provider", async () => {
  dir = mkdtempSync(join(tmpdir(), "warp-real-pi-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  writeFileSync(join(dir, "warp-simple-status.json"), JSON.stringify({ summary: { provider: "warp-test", model: "small" } }));
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models-store.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  const faux = fauxProvider({ provider: "warp-test", models: [{ id: "small" }], tokensPerSecond: 100000 });
  runtime.registerNativeProvider(faux.provider);
  const modelRegistry = new ModelRegistry(runtime);
  const sessionManager = SessionManager.inMemory("/tmp/warp-test");
  sessionManager.appendMessage({ role: "user", content: "Create status-summary branch", timestamp: 0 });
  sessionManager.appendMessage(fauxAssistantMessage("Created status-summary from main."));
  let sentText: unknown;
  faux.setResponses([(context) => {
    sentText = context.messages.find(message => message.role === "user")?.content;
    return fauxAssistantMessage("Created the requested branch from main");
  }]);
  const summary = await summarizeTurn({ modelRegistry, sessionManager } as unknown as ExtensionContext, loadSummaryConfig()!, new AbortController().signal);
  expect(summary).toBe("Created the requested branch from main");
  expect(JSON.stringify(sentText)).toContain("Created status-summary from main.");
  expect(sessionManager.getBranch().filter(entry => entry.type === "message")).toHaveLength(2);
});
