/**
 * Electron main process: boots the bundled Fastify server on the fixed local
 * port (5175 — same as dev and `npm start`) with the database under the OS
 * user-data dir, then points a plain window at it. The app is a shell — all
 * logic lives in the server bundle.
 *
 * The port is fixed on purpose: the Tampermonkey netdisk script
 * (netdisk/aiya-netdisk.user.js) finds this client at http://127.0.0.1:5175,
 * so a random port would leave the packaged app invisible to it.
 */
import { app, BrowserWindow, dialog, shell } from "electron";
import path from "node:path";

// The server bundle reads this at import time: keep the local db out of the
// install dir and inside the per-user application data folder.
process.env.PUBLISHER_DATA = path.join(app.getPath("userData"), "data");

const { PUBLISHER_PORT, listenWithPortguard } = await import("../dist-server/index.js");

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

    // Open target=_blank links (front-end post pages) in the system browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
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
    } catch {
        dialog.showErrorBox(
            "AIYA 发帖器",
            `端口 ${PUBLISHER_PORT} 被占用，无法启动。\n若正在运行 dev 或另一个发帖器实例，先关掉它再试。`,
        );
        app.quit();
        return;
    }
    const baseUrl = `http://127.0.0.1:${PUBLISHER_PORT}`;
    console.log(`server on ${baseUrl}, db under ${process.env.PUBLISHER_DATA}`);

    createWindow(baseUrl);

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow(baseUrl);
        }
    });
});

app.on("window-all-closed", () => {
    app.quit();
});
