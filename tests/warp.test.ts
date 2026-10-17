import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({ openSync: vi.fn(), writeSync: vi.fn(), closeSync: vi.fn() }));
import { supportsWarp, writeStatus } from "../src/warp.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}
function setTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

beforeEach(() => {
  vi.stubEnv("TERM_PROGRAM", "WarpTerminal");
  vi.stubEnv("WARP_CLI_AGENT_PROTOCOL_VERSION", "1");
  setPlatform("darwin");
  vi.mocked(fs.openSync).mockReturnValue(42);
  vi.mocked(fs.writeSync).mockReturnValue(1);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", platformDescriptor);
  if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
  else Reflect.deleteProperty(process.stdout, "isTTY");
});

const session = { id: "foreground", cwd: "/home/me/project" };

describe("Warp transport", () => {
  it.each(["1", "2", "99"])("accepts supported advertised protocol %s", (version) => {
    vi.stubEnv("WARP_CLI_AGENT_PROTOCOL_VERSION", version);
    expect(supportsWarp()).toBe(true);
  });
  it.each([undefined, "", "0", "-1", "garbage", "1x", "1.5", "Infinity"])("rejects protocol %s", (version) => {
    vi.stubEnv("WARP_CLI_AGENT_PROTOCOL_VERSION", version);
    expect(supportsWarp()).toBe(false);
    writeStatus("stop", session);
    expect(fs.openSync).not.toHaveBeenCalled();
  });
  it("does not write outside Warp", () => {
    vi.stubEnv("TERM_PROGRAM", "OtherTerminal");
    expect(supportsWarp()).toBe(false);
    writeStatus("session_start", session);
    expect(fs.openSync).not.toHaveBeenCalled();
  });
  it.each(["session_start", "prompt_submit", "stop"] as const)("writes the exact %s envelope and closes tty", (event) => {
    writeStatus(event, session);
    const extras = event === "prompt_submit" ? { query: "" } : event === "stop" ? { query: "", response: "Pi finished responding." } : {};
    const body = { v: 1, agent: "pi", event, session_id: "foreground", cwd: "/home/me/project", project: "project", ...extras };
    expect(fs.openSync).toHaveBeenCalledWith("/dev/tty", "w");
    expect(fs.writeSync).toHaveBeenCalledWith(42, `\x1b]777;notify;warp://cli-agent;${JSON.stringify(body)}\x07`);
    expect(fs.closeSync).toHaveBeenCalledWith(42);
  });
  it("includes the supplied summary only in stop, escaping terminal controls", () => {
    const response = "Created the branch with escaped \x07\x1b characters";
    writeStatus("stop", session, response);
    const bytes = String(vi.mocked(fs.writeSync).mock.calls[0][1]);
    expect(JSON.parse(bytes.slice("\x1b]777;notify;warp://cli-agent;".length, -1)).response).toBe(response);
    expect(bytes.slice(2, -1)).not.toContain("\x07");
    expect(bytes.slice(2, -1)).not.toContain("\x1b");
    writeStatus("prompt_submit", session, response);
    const busyBytes = String(vi.mocked(fs.writeSync).mock.calls[1][1]);
    expect(JSON.parse(busyBytes.slice("\x1b]777;notify;warp://cli-agent;".length, -1))).not.toHaveProperty("response");
  });
  it("escapes control characters in metadata", () => {
    writeStatus("stop", { id: "id\x07\x1b", cwd: "/home/me/\nproject" });
    const bytes = String(vi.mocked(fs.writeSync).mock.calls[0][1]);
    expect(bytes.slice(2, -1)).not.toContain("\x07");
    expect(bytes.slice(2, -1)).not.toContain("\x1b");
    expect(JSON.parse(bytes.slice("\x1b]777;notify;warp://cli-agent;".length, -1)).session_id).toBe("id\x07\x1b");
  });
  it("swallows tty-open errors", () => {
    vi.mocked(fs.openSync).mockImplementation(() => { throw new Error("no tty"); });
    expect(() => writeStatus("stop", session)).not.toThrow();
    expect(fs.closeSync).not.toHaveBeenCalled();
  });
  it("closes tty after write errors", () => {
    vi.mocked(fs.writeSync).mockImplementation(() => { throw new Error("broken tty"); });
    expect(() => writeStatus("stop", session)).not.toThrow();
    expect(fs.closeSync).toHaveBeenCalledWith(42);
  });
  it("swallows close errors", () => {
    vi.mocked(fs.closeSync).mockImplementation(() => { throw new Error("close failed"); });
    expect(() => writeStatus("stop", session)).not.toThrow();
  });
  it("writes to Windows TTY stdout only", () => {
    setPlatform("win32");
    setTTY(true);
    const streamWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    writeStatus("stop", session);
    expect(fs.writeSync).toHaveBeenCalledWith(process.stdout.fd, expect.stringContaining("\"event\":\"stop\""));
    expect(streamWrite).not.toHaveBeenCalled();
    expect(fs.openSync).not.toHaveBeenCalled();
    expect(fs.closeSync).not.toHaveBeenCalled();
  });
  it("does not write to redirected Windows stdout", () => {
    setPlatform("win32");
    setTTY(false);
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    writeStatus("stop", session);
    expect(write).not.toHaveBeenCalled();
    expect(fs.writeSync).not.toHaveBeenCalled();
  });
  it("contains Windows write errors without using the asynchronous stream", () => {
    setPlatform("win32");
    setTTY(true);
    const streamWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.mocked(fs.writeSync).mockImplementation(() => { throw new Error("broken stdout"); });
    expect(() => writeStatus("stop", session)).not.toThrow();
    expect(fs.writeSync).toHaveBeenCalledWith(process.stdout.fd, expect.any(String));
    expect(streamWrite).not.toHaveBeenCalled();
    expect(fs.closeSync).not.toHaveBeenCalled();
  });
});
