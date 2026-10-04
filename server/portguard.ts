/**
 * Stale-instance takeover for the fixed port (5175). A hard-killed publisher
 * leaves its server process running as an orphan that still holds the port —
 * Windows task semantics kill the tree root only — and every later start
 * would die on EADDRINUSE with no recourse but a manual taskkill. On bind
 * failure the squatter is identified over HTTP (this tool's own /api/state
 * shape) and only then tree-killed and retried. Taking over a healthy
 * instance is deliberate: for a single-user local tool, "whoever starts last
 * owns the port" is the invariant that matters.
 */

import { execFileSync, spawn } from "node:child_process";

export interface PortSquatter {
    pid: number;
    image: string | null;
}

/** The PID listening on the port, via netstat (win32) or lsof (posix). */
export function listenerPid(port: number): PortSquatter | null {
    try {
        if (process.platform === "win32") {
            const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
            for (const line of out.split("\n")) {
                const match = new RegExp(`\\sTCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`).exec(line);
                if (match) {
                    const pid = Number(match[1]);
                    return { pid, image: imageOf(pid) };
                }
            }
            return null;
        }
        const out = execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        const pid = Number(out.split("\n")[0]);
        return Number.isInteger(pid) && pid > 0 ? { pid, image: imageOf(pid) } : null;
    } catch {
        return null;
    }
}

function imageOf(pid: number): string | null {
    try {
        if (process.platform === "win32") {
            const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            });
            const match = /^"([^"]+)"/.exec(out.trim());
            return match ? (match[1] ?? null) : null;
        }
        return execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).trim() || null;
    } catch {
        return null;
    }
}

/** True when the HTTP endpoint on the port answers with this tool's
 * /api/state shape — the only kind of squatter we ever kill. Probed on both
 * stacks: a Vite orphan binds ::1, our own server binds 127.0.0.1. */
export async function isOurStateEndpoint(port: number): Promise<boolean> {
    for (const host of ["127.0.0.1", "[::1]"]) {
        try {
            const response = await fetch(`http://${host}:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
            if (!response.ok) {
                continue;
            }
            const body = (await response.json()) as unknown;
            if (body !== null && typeof body === "object" && "settings" in body && "posts" in body) {
                return true;
            }
        } catch {
            // try the other stack
        }
    }
    return false;
}

/** Kill the whole process tree — the npm/shell middle layers die with the
 * child, which is exactly what plain terminate does not do on Windows. */
export function killTree(pid: number): void {
    if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
        return;
    }
    try {
        process.kill(pid, "SIGTERM");
    } catch {
        // already gone
    }
}
