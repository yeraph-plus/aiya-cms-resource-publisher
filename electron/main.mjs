/**
 * Electron main process: boots the bundled Fastify server on a random local
 * port with the database under the OS user-data dir, then points a plain
 * window at it. The app is a shell — all logic lives in the server bundle.
 */
import { app, BrowserWindow, shell } from "electron";
import path from "node:path";

// The server bundle reads this at import time: keep the local db out of the
// install dir and inside the per-user application data folder.
process.env.PUBLISHER_DATA = path.join(app.getPath("userData"), "data");

const { buildApp } = await import("../dist-server/index.js");

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
    const application = await buildApp();
    await application.listen({ port: 0, host: "127.0.0.1" });
    const address = application.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
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
