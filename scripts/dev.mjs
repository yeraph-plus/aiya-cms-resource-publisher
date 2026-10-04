#!/usr/bin/env node
/**
 * Dev supervisor for the two-port form (API 5175 + Vite 5173).
 *
 * Why this replaced `concurrently -k`: a hard kill of the supervisor (任务
 * 管理器结束进程、外部工具强杀) runs no signal handler — on Windows the two
 * children survive as orphans holding the ports, and every later start dies
 * on EADDRINUSE. This script:
 *   - evicts a stale Vite of THIS tool from 5173 before spawning (HTTP
 *     fingerprint, never a blind kill; 5175 is the server's own job — it
 *     takes its port back on bind failure via server/portguard.ts),
 *   - tree-kills both children (taskkill /T /F) on Ctrl+C, SIGTERM, or when
 *     either child exits, so no npm/shell middle layer outlives a signal.
 */

import { execFileSync, spawn } from "node:child_process";

const WEB_PORT = 5173;
const isWin = process.platform === "win32";

const CHILDREN = [
    { name: "server", color: "\x1b[34m", args: ["run", "dev:server"] },
    { name: "web", color: "\x1b[32m", args: ["run", "dev:web"] },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listenerPid(port) {
    try {
        if (isWin) {
            const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
            for (const line of out.split("\n")) {
                const match = new RegExp(`\\sTCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`).exec(line);
                if (match) {
                    return Number(match[1]);
                }
            }
            return null;
        }
        const out = execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" }).trim();
        const pid = Number(out.split("\n")[0]);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
}

function imageOf(pid) {
    try {
        if (isWin) {
            const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            });
            const match = /^"([^"]+)"/.exec(out.trim());
            return match ? match[1] : null;
        }
        return execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).trim() || null;
    } catch {
        return null;
    }
}

function killTree(pid) {
    if (isWin) {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
        return;
    }
    try {
        process.kill(pid, "SIGTERM");
    } catch {
        // already gone
    }
}

/** A squatter on 5173 is only evicted when it answers like our own Vite dev
 * server — the dev HTML carries the injected HMR client and our title. Both
 * stacks are probed: a Vite orphan can bind ::1 alone. */
async function isOurVite(port) {
    for (const host of ["127.0.0.1", "[::1]"]) {
        try {
            const response = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(1500) });
            const text = response.ok ? await response.text() : "";
            if (text.includes("@vite/client") && text.includes("AIYA 发帖器")) {
                return true;
            }
        } catch {
            // try the other stack
        }
    }
    return false;
}

async function evictStaleVite() {
    const pid = listenerPid(WEB_PORT);
    if (pid === null) {
        return;
    }
    if (!(await isOurVite(WEB_PORT))) {
        const image = imageOf(pid);
        console.error(
            `端口 ${WEB_PORT} 被其它进程占用（PID ${pid}${image ? `，${image}` : ""}）——不是本工具的 Vite 实例，请自行处理后再启动 dev。`,
        );
        process.exit(1);
    }
    console.log(`[dev] 端口 ${WEB_PORT} 上是本工具的残留 Vite（PID ${pid}，强杀遗留的孤儿），接管中……`);
    killTree(pid);
    await sleep(800);
}

const procs = new Map();
let shuttingDown = false;

function shutdown(code) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    for (const proc of procs.values()) {
        if (proc.exitCode === null && proc.pid) {
            killTree(proc.pid);
        }
    }
    setTimeout(() => process.exit(code), 500);
}

function spawnChild(child) {
    const proc = spawn(isWin ? "npm.cmd" : "npm", child.args, {
        shell: isWin,
        stdio: ["ignore", "pipe", "pipe"],
        ...(isWin ? {} : { detached: true }),
    });
    procs.set(child.name, proc);
    const tag = `${child.color}[${child.name}]\x1b[0m`;
    for (const stream of ["stdout", "stderr"]) {
        proc[stream].setEncoding("utf8");
        let buffer = "";
        proc[stream].on("data", (chunk) => {
            buffer += chunk;
            let index;
            while ((index = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, index).replace(/\r$/, "");
                buffer = buffer.slice(index + 1);
                if (line !== "") {
                    console.log(`${tag} ${line}`);
                }
            }
        });
    }
    proc.on("exit", (code) => {
        if (shuttingDown) {
            return;
        }
        console.error(`[dev] ${child.name} 子进程退出（code ${code ?? "?"}），结束另一个并退出。`);
        shutdown(code ?? 1);
    });
}

await evictStaleVite();
for (const child of CHILDREN) {
    spawnChild(child);
}
