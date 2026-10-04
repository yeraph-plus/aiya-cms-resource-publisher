// ==UserScript==
// @name         AIYA 网盘分享回填（百度）
// @namespace    aiya-netdisk
// @version      0.2.0
// @description  在百度网盘 web 端定位发帖器同名目录、创建分享并把链接回填到发帖器文件列表（自动勾选推送）。上传由网盘客户端完成，本脚本只做「定位 → 分享 → 回填」。
// @match        https://pan.baidu.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
    "use strict";

    // ---------- 配置（GM 存储，面板可改） -----------------------------------
    const cfg = {
        publisher: GM_getValue("publisher", "http://127.0.0.1:5175"),
        rootDir: GM_getValue("rootDir", "/"),
        period: GM_getValue("period", "0"), // 分享有效期（天）；0 = 永久（需会员，过期自动回落提示）
        autoRun: false,
    };
    const saveCfg = () => {
        GM_setValue("publisher", cfg.publisher);
        GM_setValue("rootDir", cfg.rootDir);
        GM_setValue("period", cfg.period);
    };

    // ---------- 基础工具 -----------------------------------------------------
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const CODE_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";
    const randomCode = () =>
        Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");

    /** Same-origin calls ride plain fetch (cookies attach automatically);
     * paths are literal ("/api/list", "/share/set", …). JSON parse failures
     * surface the HTTP status and the first bytes instead of a bare
     * "Unexpected end of JSON input". */
    async function apiJson(path, { params, method = "GET", form } = {}) {
        const query = new URLSearchParams(params ?? {});
        const url = `${path}${query.size ? `?${query}` : ""}`;
        const response = await fetch(url, {
            method,
            credentials: "include",
            headers: form ? { "Content-Type": "application/x-www-form-urlencoded" } : { Accept: "application/json, text/plain, */*" },
            body: form ? new URLSearchParams(form).toString() : undefined,
        });
        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`${path} 返回非 JSON（HTTP ${response.status}）：${text.slice(0, 80) || "（空响应）"}`);
        }
    }

    function publisherFetch(path, options) {
        const url = `${cfg.publisher}${path}`;
        if (typeof GM_xmlhttpRequest === "function") {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: options?.method ?? "GET",
                    url,
                    data: options?.body,
                    headers: options?.headers ?? {},
                    timeout: 15000,
                    onload: (response) => {
                        try {
                            resolve(JSON.parse(response.responseText));
                        } catch {
                            reject(new Error(`HTTP ${response.status}，响应不是 JSON`));
                        }
                    },
                    onerror: () => reject(new Error("无法连接发帖器（未启动？）")),
                    ontimeout: () => reject(new Error("连接发帖器超时")),
                });
            });
        }
        return fetch(url, { ...options }).then((response) => {
            if (!response.ok) {
                return response
                    .json()
                    .catch(() => ({}))
                    .then((body) => {
                        throw new Error(body.error ?? `HTTP ${response.status}`);
                    });
            }
            return response.json();
        });
    }

    // ---------- 网盘侧动作 ---------------------------------------------------
    let bdstoken = null;

    async function getBdstoken() {
        if (bdstoken) {
            return bdstoken;
        }
        const result = await apiJson("/api/gettemplatevariable", {
            params: { clienttype: 0, app_id: 250528, web: 1, fields: '["bdstoken"]' },
        });
        if (result?.errno !== 0 || !result?.result?.bdstoken) {
            throw new Error(`取 bdstoken 失败（errno=${result?.errno}）——登录态可能失效`);
        }
        bdstoken = result.result.bdstoken;
        return bdstoken;
    }

    /** The staged folder's entry under the configured root: depth-1 listing
     * first (deterministic), the netdisk search as the fallback. */
    async function findFolder(dirName) {
        for (let page = 1; ; page += 1) {
            const result = await apiJson("/api/list", {
                params: {
                    dir: cfg.rootDir,
                    order: "name",
                    desc: 0,
                    num: 1000,
                    page,
                    clienttype: 0,
                    app_id: 250528,
                    web: 1,
                },
            });
            if (result?.errno !== 0) {
                throw new Error(`列目录失败（errno=${result?.errno}）——登录态可能失效或根目录不存在`);
            }
            const entries = result.list ?? result.data ?? [];
            const hit = entries.find(
                (entry) => (Number(entry.isdir) === 1 || entry.isdir === "1") &&
                    (entry.server_filename === dirName || entry.server_filename?.startsWith(`${dirName}-`)),
            );
            if (hit) {
                return hit;
            }
            if (entries.length < 1000) {
                throw new Error(`根目录 ${cfg.rootDir} 下没找到 ${dirName}（确认客户端已上传完成）`);
            }
        }
    }

    async function createShare(entry, code) {
        const token = await getBdstoken();
        const result = await apiJson("/share/set", {
            params: { app_id: 250528, web: 1, channel: "dlna", clienttype: 0, page: 1, from: "web" },
            method: "POST",
            form: {
                period: cfg.period,
                pwd: code,
                schannel: 4,
                channel_list: "[]",
                fid_list: JSON.stringify([entry.fs_id]),
                bdstoken: token,
            },
        });
        if (result?.errno !== 0) {
            const hints = {
                [-6]: "登录态失效",
                [-7]: "参数或风控拦截",
                [-9]: "文件不存在（fs_id 失效）",
                [-15]: "分享过于频繁（逐行节奏被打破？）",
                [-70]: "该账号不支持永久分享（换 30/7 天试试）",
                105: "分享链接数达到上限",
            };
            throw new Error(`创建分享失败（errno=${result?.errno}${hints[result?.errno] ? `：${hints[result?.errno]}` : ""}）`);
        }
        const link = result?.link ?? result?.info?.[0]?.shorturl ?? result?.info?.[0]?.dlink;
        if (!link) {
            throw new Error("分享创建成功但响应里没有链接（响应形状变了，需要更新脚本）");
        }
        return link;
    }

    // ---------- 单行处理 -----------------------------------------------------
    async function processItem(item) {
        setStatus(item, "run", "定位目录…");
        const entry = await findFolder(item.dirName);
        setStatus(item, "run", `创建分享（${entry.server_filename}）…`);
        const code = randomCode();
        const link = await createShare(entry, code);
        setStatus(item, "run", "回填发帖器…");
        await publisherFetch("/api/netdisk/result", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ localId: item.localId, groupId: item.groupId, url: link, code }),
        });
        const periodText = cfg.period === "0" ? "永久" : `${cfg.period} 天`;
        setStatus(item, "done", `已回填：${link}（提取码 ${code} · ${periodText}，已勾选推送）`);
    }

    // ---------- 队列循环 -----------------------------------------------------
    let running = false;

    async function runQueue() {
        if (running) {
            return;
        }
        running = true;
        try {
            for (;;) {
                const pending = queue.filter((item) => !item.status || item.status === "fail");
                if (pending.length === 0 || !running) {
                    break;
                }
                const item = pending[0];
                try {
                    await processItem(item);
                } catch (error) {
                    setStatus(item, "fail", String(error.message ?? error));
                    // A failed item ends the auto pass: netdisk failures are
                    // per-row conditions (not uploaded yet) or risk signals
                    // that deserve a human look before hammering on.
                    break;
                }
                await sleep(2000 + Math.floor(Math.random() * 2000));
            }
        } finally {
            running = false;
            renderControls();
        }
    }

    // ---------- 面板 UI ------------------------------------------------------
    let queue = [];
    const panel = document.createElement("div");
    panel.id = "aiya-netdisk-panel";
    panel.style.cssText = [
        "position:fixed", "right:16px", "top:64px", "z-index:999999", "width:420px",
        "background:#fff", "border:1px solid #ddd", "border-radius:8px", "box-shadow:0 4px 16px rgba(0,0,0,.18)",
        "font:12px/1.5 system-ui,sans-serif", "color:#333", "display:none",
    ].join(";");

    function setStatus(item, status, text) {
        item.status = status;
        item.statusText = text;
        renderQueue();
    }

    function renderControls() {
        panel.querySelector("#aiya-run").textContent = running ? "停止" : "开始处理";
    }

    function renderQueue() {
        const box = panel.querySelector("#aiya-queue");
        box.innerHTML = "";
        if (queue.length === 0) {
            box.innerHTML = '<div style="color:#999;padding:6px 2px">队列为空：在发帖器里给已上线行添加空链接的网盘组后点「刷新队列」。</div>';
            return;
        }
        for (const item of queue) {
            const row = document.createElement("div");
            row.style.cssText = "padding:5px 2px;border-bottom:1px solid #f2f2f2";
            const color = item.status === "done" ? "#2e7d32" : item.status === "fail" ? "#c62828" : item.status === "run" ? "#1565c0" : "#666";
            row.innerHTML =
                `<div style="display:flex;gap:6px;align-items:baseline">` +
                `<b style="flex:none">${item.dirName}</b>` +
                `<span style="color:#888;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">组 #${item.groupId} · ${item.groupTitle}</span>` +
                `<button data-act="one" style="flex:none;cursor:pointer">处理</button></div>` +
                `<div style="color:${color};white-space:normal">${item.statusText ?? "待处理"}</div>`;
            row.querySelector("button").onclick = () => {
                if (running) {
                    return;
                }
                setStatus(item, "", "待处理");
                running = true;
                processItem(item)
                    .catch((error) => setStatus(item, "fail", String(error.message ?? error)))
                    .finally(() => {
                        running = false;
                        renderControls();
                    });
            };
            box.appendChild(row);
        }
    }

    function renderPanel() {
        panel.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #eee">
                <b>AIYA 网盘回填</b>
                <span id="aiya-close" style="margin-left:auto;cursor:pointer;color:#999">—</span>
            </div>
            <div id="aiya-body" style="padding:8px 10px;display:flex;flex-direction:column;gap:6px">
                <div style="display:flex;gap:6px;align-items:center">
                    <label style="flex:none">网盘根目录</label>
                    <input id="aiya-root" value="${cfg.rootDir}" style="flex:1;min-width:0">
                </div>
                <div style="display:flex;gap:6px;align-items:center">
                    <label style="flex:none">发帖器地址</label>
                    <input id="aiya-pub" value="${cfg.publisher}" style="flex:1;min-width:0">
                    <label style="flex:none">有效期</label>
                    <select id="aiya-period" style="flex:none">
                        <option value="0">永久（需会员）</option>
                        <option value="30">30 天</option>
                        <option value="7">7 天</option>
                        <option value="1">1 天</option>
                    </select>
                </div>
                <div style="display:flex;gap:6px;align-items:center">
                    <button id="aiya-refresh" style="cursor:pointer">刷新队列</button>
                    <button id="aiya-run" style="cursor:pointer">开始处理</button>
                    <span id="aiya-msg" style="color:#888;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis"></span>
                </div>
                <div id="aiya-queue" style="max-height:260px;overflow:auto"></div>
            </div>`;
        panel.querySelector("#aiya-close").onclick = () => {
            panel.querySelector("#aiya-body").style.display = panel.querySelector("#aiya-body").style.display === "none" ? "flex" : "none";
        };
        panel.querySelector("#aiya-root").onchange = (event) => {
            cfg.rootDir = event.target.value.trim() || "/";
            saveCfg();
            bdstoken = null;
        };
        panel.querySelector("#aiya-pub").onchange = (event) => {
            cfg.publisher = event.target.value.trim().replace(/\/+$/, "");
            saveCfg();
        };
        panel.querySelector("#aiya-period").value = cfg.period;
        panel.querySelector("#aiya-period").onchange = (event) => {
            cfg.period = event.target.value;
            saveCfg();
        };
        panel.querySelector("#aiya-refresh").onclick = async () => {
            try {
                const data = await publisherFetch("/api/netdisk/queue");
                queue = data.queue.map((item) => ({ ...item }));
                renderQueue();
            } catch (error) {
                panel.querySelector("#aiya-msg").textContent = String(error.message ?? error);
            }
        };
        panel.querySelector("#aiya-run").onclick = () => {
            if (running) {
                running = false;
                renderControls();
                return;
            }
            void runQueue();
        };
        renderQueue();
        renderControls();
    }

    // ---------- 挂钩：百度网盘顶部导航 ---------------------------------------
    // The trigger lives in the page's top bar (.wp-s-header) as "AIYA 挂钩";
    // SPA re-renders replace the bar, so a guard re-attaches it. Without the
    // bar (page redesign) it falls back to a fixed position button.
    let panelVisible = false;

    function togglePanel() {
        panelVisible = !panelVisible;
        panel.style.display = panelVisible ? "block" : "none";
        if (panelVisible && !panel.querySelector("#aiya-queue").childElementCount) {
            panel.querySelector("#aiya-refresh").click();
        }
    }

    function buildTrigger(variant) {
        const hook = document.createElement("div");
        hook.id = variant === "bar" ? "aiya-hook" : "aiya-hook-fallback";
        hook.textContent = "AIYA 挂钩";
        hook.onclick = togglePanel;
        if (variant === "bar") {
            hook.style.cssText = [
                "cursor:pointer", "padding:0 16px", "height:100%", "display:flex", "align-items:center",
                "font-size:13px", "color:#fff", "background:rgba(255,255,255,.14)", "user-select:none",
            ].join(";");
            hook.onmouseenter = () => (hook.style.background = "rgba(255,255,255,.28)");
            hook.onmouseleave = () => (hook.style.background = "rgba(255,255,255,.14)");
        } else {
            hook.style.cssText = [
                "position:fixed", "right:16px", "top:12px", "z-index:999999", "cursor:pointer",
                "background:#06a7ff", "color:#fff", "padding:6px 12px", "border-radius:16px",
                "font:bold 12px system-ui", "box-shadow:0 2px 8px rgba(0,0,0,.25)",
            ].join(";");
        }
        return hook;
    }

    function mountHook() {
        const host = document.querySelector(".wp-s-header") ?? document.querySelector(".wp-s-header-wrapper");
        if (host && !document.getElementById("aiya-hook") && !document.getElementById("aiya-hook-fallback")) {
            host.appendChild(buildTrigger("bar"));
        } else if (!host && !document.getElementById("aiya-hook-fallback") && !document.getElementById("aiya-hook")) {
            document.body.appendChild(buildTrigger("fallback"));
        }
    }

    const mount = () => {
        document.body.appendChild(panel);
        renderPanel();
        mountHook();
        setInterval(mountHook, 2000);
    };
    if (document.body) {
        mount();
    } else {
        window.addEventListener("DOMContentLoaded", mount);
    }
})();
