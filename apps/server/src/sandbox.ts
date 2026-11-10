import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "./config.js";

// Programs that read uploaded files (poppler, LibreOffice, LibreDWG, ezdxf) are the part of the server most exposed to
// hostile input. They never get the server's environment (#163): no ADMIN_TOKEN, DATABASE_URL or OPENROUTER_API_KEY.
export const toolEnv = (home = tmpdir()): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: home,
  TMPDIR: tmpdir(),
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
});

// Where a sandboxed program may look (#169): the files it reads, and the directories it writes to.
export type SandboxPaths = { read?: string[]; write?: string[] };

let bwrapWorks: boolean | null = null;

// bubblewrap needs unprivileged user namespaces. Docker's default seccomp profile blocks them, so "auto" checks once and
// falls back to running the program directly (still with the minimal environment) when they are not there.
export const sandboxAvailable = () => {
  if (config.converterSandbox === "off") return false;
  if (bwrapWorks === null) {
    try {
      execFileSync(config.bwrap, ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "true"], {
        env: toolEnv(),
        stdio: "ignore",
        timeout: 10_000,
      });
      bwrapWorks = true;
    } catch {
      bwrapWorks = false;
      const message = "bubblewrap niedostępny: konwertery plików działają bez piaskownicy (tylko z minimalnym środowiskiem)";
      if (config.converterSandbox === "bwrap") throw new Error(message);
      console.warn(`sandbox: ${message}`);
    }
  }
  if (!bwrapWorks && config.converterSandbox === "bwrap") throw new Error("bubblewrap niedostępny, a CONVERTER_SANDBOX=bwrap");
  return bwrapWorks;
};

// Only for tests.
export const resetSandboxProbe = () => {
  bwrapWorks = null;
};

const SYSTEM_DIRS = ["/usr", "/etc", "/opt", "/lib", "/lib64", "/lib32", "/bin", "/sbin"];

const systemMounts = () =>
  SYSTEM_DIRS.flatMap((dir) => {
    try {
      // Merged /usr (Debian bookworm, Ubuntu): /lib and /bin are links into /usr.
      return lstatSync(dir).isSymbolicLink() ? ["--symlink", readlinkSync(dir), dir] : ["--ro-bind", dir, dir];
    } catch {
      return [];
    }
  });

// The command line that runs `command` inside bubblewrap: no network, no other processes, an empty /tmp, read-only
// system directories, and from the data directory only the files of this one conversion.
export const sandboxed = (command: string, args: string[], paths: SandboxPaths, home: string): [string, string[]] => {
  if (!sandboxAvailable()) return [command, args];
  // A program outside the system directories (a test double, a venv elsewhere) is visible read-only.
  const programs = path.isAbsolute(command) && !SYSTEM_DIRS.some((dir) => command.startsWith(`${dir}/`)) ? [command] : [];
  const binds = [
    ...[...programs, ...(paths.read ?? [])].flatMap((file) => ["--ro-bind", file, file]),
    ...(paths.write ?? []).flatMap((dir) => ["--bind", dir, dir]),
  ];
  return [
    config.bwrap,
    [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      ...systemMounts(),
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      ...binds,
      "--clearenv",
      ...Object.entries(toolEnv(home)).flatMap(([key, value]) => ["--setenv", key, value ?? ""]),
      "--chdir",
      "/tmp",
      "--",
      command,
      ...args,
    ],
  ];
};
