/**
 * Electron main process: boots the bundled Fastify server on the fixed local
 * port (5175 — same as dev and `npm start`) with the database under the OS
 * user-data dir, points a plain window at it, and keeps the intake window
 * (5180) running beside it. The app is a shell — all logic lives in the two
 * server bundles.
 *
 * Both ports are fixed on purpose: the Tampermonkey netdisk script
 * (netdisk/aiya-netdisk.user.js) finds this client at http://127.0.0.1:5175,
 * and the main window's 智能摄取 button opens http://127.0.0.1:5180, so a
 * random port would leave one of them invisible.
 */
import { app, BrowserWindow, dialog, shell } from "electron";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The server bundle reads this at import time: keep the local db out of the
// install dir and inside the per-user application data folder. The intake
// window keeps its own config file (model, key, prompts) in the same
// directory, so the packaged app's 智能摄取 starts empty and stays local.
const dataDir = path.join(app.getPath("userData"), "data");
process.env.PUBLISHER_DATA = dataDir;

const here = path.dirname(fileURLToPath(import.meta.url));

const { PUBLISHER_PORT, listenWithPortguard } = await import("../dist-server/index.js");

/** The intake window's own port; the main window's 智能摄取 button points here. */
const INTAKE_PORT = Number(process.env.INTAKE_PORT ?? 5180);
const INTAKE_URL = `http://127.0.0.1:${INTAKE_PORT}`;

/** The child process running the 智能摄取 window, killed on quit. */
let intake = null;
/** The 智能摄取 window, so the button focuses it instead of stacking copies. */
let intakeWindow = null;

/**
 * Starts the intake bundle as a second local process. Electron's own binary
 * runs it as plain Node (ELECTRON_RUN_AS_NODE) — the packaged app has no
 * separate node.exe — which is exactly what that bundle expects: it holds the
 * model credentials and owns port 5180, nothing else. PUBLISHER_URL tells it
 * where the configuration it reads lives.
 *
 * A failure here is not fatal: the window's button points at the port, so a
 * repo-side `npm run intake` (or an earlier copy of this child) keeps it
 * working. Without the bundle there is nothing to start, and the button would
 * open a dead port, so that is said out loud.
 */
function startIntake() {
    const bundle = path.join(here, "..", "dist-intake", "index.js");
    if (!existsSync(bundle)) {
        console.warn(`intake bundle missing (${bundle}) — the 智能摄取 button will not answer.`);
        return null;
    }
    const child = fork(bundle, [], {
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            PUBLISHER_DATA: dataDir,
            PUBLISHER_URL: `http://127.0.0.1:${PUBLISHER_PORT}`,
            INTAKE_PORT: String(INTAKE_PORT),
        },
        silent: true,
    });
    child.stdout?.on("data", (chunk) => console.log(`[intake] ${String(chunk).trimEnd()}`));
    child.stderr?.on("data", (chunk) => console.error(`[intake] ${String(chunk).trimEnd()}`));
    child.on("exit", (code, signal) => console.log(`[intake] exited (code ${code}, signal ${signal})`));
    return child;
}

/** True for the intake window's own address (and nothing else local). */
function isIntakeUrl(url) {
    try {
        const parsed = new URL(url);
        return (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && parsed.port === String(INTAKE_PORT);
    } catch {
        return false;
    }
}

/**
 * The 智能摄取 window, opened by the main window's button. It is a real app
 * window (not `shell.openExternal`): the intake UI belongs to this app, and a
 * browser tab would sit outside the process that starts it. An already-open one
 * is focused rather than duplicated.
 */
function openIntakeWindow() {
    if (intakeWindow !== null && !intakeWindow.isDestroyed()) {
        intakeWindow.focus();
        return;
    }
    intakeWindow = new BrowserWindow({
        width: 1280,
        height: 900,
        title: "AIYA 智能摄取",
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    });
    intakeWindow.on("closed", () => {
        intakeWindow = null;
    });
    // Its own links (a model provider's docs, say) still belong to the browser.
    intakeWindow.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: "deny" };
    });
    void intakeWindow.loadURL(INTAKE_URL);
}

function createWindow(baseUrl) {
    const win = new BrowserWindow({
        width: 1440,
        height: 900,
        title: "AIYA 发帖器",
        autoHideMenuBar: true,
        webPreferences: {
            // The renderer talks only to the local server; no node integration.
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    // Target=_blank links open in this app when they are the intake window and
    // in the system browser otherwise (front-end post pages).
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (isIntakeUrl(url)) {
            openIntakeWindow();
            return { action: "deny" };
        }
        void shell.openExternal(url);
        return { action: "deny" };
    });

    void win.loadURL(baseUrl);
    return win;
}

app.whenReady().then(async () => {
    try {
        // Same fixed port and same stale-instance takeover as the CLI entry.
        await listenWithPortguard(PUBLISHER_PORT);
    } catch (error) {
        // listenWithPortguard has already said which process holds the port;
        // the dialog is the part a double-clicking user actually sees.
        dialog.showErrorBox(
            "AIYA 发帖器",
            `启动失败：端口 ${PUBLISHER_PORT} 被占用，或服务端没能起来。\n${error instanceof Error ? error.message : String(error)}\n若正在运行 dev 或另一个发帖器实例，先关掉它再试。`,
        );
        app.quit();
        return;
    }
    const baseUrl = `http://127.0.0.1:${PUBLISHER_PORT}`;
    console.log(`server on ${baseUrl}, db under ${dataDir}`);

    intake = startIntake();
    createWindow(baseUrl);

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow(baseUrl);
        }
    });
});

app.on("before-quit", () => {
    intake?.kill();
});

app.on("window-all-closed", () => {
    app.quit();
});
