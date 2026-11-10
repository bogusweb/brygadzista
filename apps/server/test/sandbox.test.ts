import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { sandboxAvailable, sandboxed, toolEnv } from "../src/sandbox.js";

const execFileAsync = promisify(execFile);

describe("converter environment (#163)", () => {
  it("passes no secrets of the server to programs that read uploads", () => {
    const env = toolEnv("/tmp/x");

    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"]);
    expect(JSON.stringify(env)).not.toContain(config.adminToken);
  });
});

describe.skipIf(!sandboxAvailable())("converter sandbox (#169)", () => {
  const run = async (script: string, paths: { read?: string[]; write?: string[] }) => {
    const [program, args] = sandboxed("sh", ["-c", script], paths, "/tmp");
    return execFileAsync(program, args, { env: toolEnv() }).then(
      ({ stdout }) => ({ ok: true, stdout }),
      (error: { stdout?: string }) => ({ ok: false, stdout: error.stdout ?? "" }),
    );
  };

  it("shows only the files of this conversion", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "brygadzista-sandbox-"));
    const input = path.join(dir, "input.txt");
    const other = path.join(dir, "inna-firma.txt");
    await writeFile(input, "wejście");
    await writeFile(other, "cudze dane");

    expect((await run(`cat ${input}`, { read: [input] })).stdout).toBe("wejście");
    expect((await run(`cat ${other}`, { read: [input] })).ok).toBe(false);
    expect((await run(`echo x > ${input}`, { read: [input] })).ok).toBe(false);
  });

  it("has no network and no server environment", async () => {
    const interfaces = (await run("tail -n +3 /proc/net/dev | cut -d: -f1", {})).stdout.split("\n").map((name) => name.trim()).filter(Boolean);
    expect(interfaces).toEqual(["lo"]);
    expect((await run("env", {})).stdout).not.toContain("DATABASE_URL");
  });
});
