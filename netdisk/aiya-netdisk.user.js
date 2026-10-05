// ==UserScript==
// @name         AIYA 网盘分享回填（百度）
// @namespace    aiya-netdisk
// @version      0.5.1
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
        period: GM_getValue("period", "0"), // 分享有效期（天）；0 = 永久（需会员）
    };
    const saveCfg = () => {
        GM_setValue("publisher", cfg.publisher);
        GM_setValue("rootDir", cfg.rootDir);
        GM_setValue("period", cfg.period);
    };
    const publisherHost = () => cfg.publisher.replace(/^https?:\/\//, "");

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

    /** The staged folder under the configured root: listed first (covers the
     * uploaded-already case), created when missing — the share is a live view
     * of the folder, so files the client uploads afterwards simply appear in
     * it. Identification is the 6-digit padded id exactly. */
    async function findFolder(dirName) {
        const id = dirName.split("-")[0];
        const matchName = (name) => name === id || name.startsWith(`${id}-`);
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
                (entry) => (Number(entry.isdir) === 1 || entry.isdir === "1") && matchName(entry.server_filename ?? ""),
            );
            if (hit) {
                return { entry: hit, created: false };
            }
            if (entries.length < 1000) {
                break;
            }
        }
        // Not found: create it (the new stack's /api/create; /api/createDir is
        // dead and answers errno 10).
        const token = await getBdstoken();
        const created = await apiJson("/api/create", {
            params: { a: "commit", bdstoken: token, clienttype: 0, app_id: 250528, web: 1 },
            method: "POST",
            form: {
                path: `${cfg.rootDir === "/" ? "" : cfg.rootDir}/${dirName}`,
                isdir: 1,
                block_list: "[]",
            },
        });
        if (created?.errno !== 0 && created?.errno !== 12) {
            const hints = { [-6]: "登录态失效", [-8]: "目录已存在", [-10]: "空间不足或参数错误" };
            throw new Error(`创建网盘目录失败（errno=${created?.errno}${hints[created?.errno] ? `：${hints[created?.errno]}` : ""}）`);
        }
        // Re-list to pick up the new folder's fs_id.
        const listing = await apiJson("/api/list", {
            params: { dir: cfg.rootDir, order: "name", desc: 0, num: 1000, page: 1, clienttype: 0, app_id: 250528, web: 1 },
        });
        if (listing?.errno !== 0) {
            throw new Error(`目录已创建但回列失败（errno=${listing?.errno}）——重试一次即可`);
        }
        const entry = (listing.list ?? listing.data ?? []).find(
            (e) => (Number(e.isdir) === 1 || e.isdir === "1") && e.server_filename === dirName,
        );
        if (!entry) {
            throw new Error(`目录已创建但回列没有看到 ${dirName}——重试一次即可`);
        }
        return { entry, created: true };
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
    const PIPELINE = "baidu"; // 本脚本所属管线；队列只认领 netdisk=baidu 的空链接组

    async function processItem(item) {
        setStatus(item, "run", "定位/创建目录…");
        const { entry, created } = await findFolder(item.dirName);
        setStatus(item, "run", `${created ? "已创建" : "已定位"} ${entry.server_filename}，创建分享…`);
        const code = randomCode();
        const link = await createShare(entry, code);
        setStatus(item, "run", "回填发帖器…");
        await publisherFetch("/api/netdisk/result", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ localId: item.localId, groupId: item.groupId, netdisk: PIPELINE, url: link, code }),
        });
        const periodText = cfg.period === "0" ? "永久" : `${cfg.period} 天`;
        setStatus(
            item,
            "done",
            `已回填：${link}（提取码 ${code} · ${periodText}）` +
                (created ? "；客户端把文件传进该目录即可，分享实时可见" : ""),
        );
    }

    // ---------- 队列循环 -----------------------------------------------------
    let running = false;

    async function runQueue() {
        if (running) {
            return;
        }
        running = true;
        renderHookText();
        try {
            for (;;) {
                const pending = queue.filter((item) => !item.status || item.status === "fail");
                if (pending.length === 0 || !running) {
                    if (pending.length === 0 && queue.every((item) => item.status === "done")) {
                        setMsg("队列处理完毕。");
                    } else if (pending.length === 0) {
                        setMsg("队列为空，无可处理行（先在发帖器加空链接组，或清空组链接重取）。");
                    }
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
            renderHookText();
            renderControls();
        }
    }

    // ---------- 面板（普通气泡：点挂钩开，点外面关） --------------------------
    let queue = [];
    const panel = document.createElement("div");
    panel.id = "aiya-netdisk-panel";
    panel.style.cssText = [
        "position:fixed", "right:16px", "top:64px", "z-index:2147483000", "width:420px",
        "background:#fff", "border:1px solid #ddd", "border-radius:8px", "box-shadow:0 4px 16px rgba(0,0,0,.18)",
        "font:12px/1.5 system-ui,sans-serif", "color:#333", "display:none",
    ].join(";");

    function setStatus(item, status, text) {
        item.status = status;
        item.statusText = text;
        renderQueue();
    }

    function renderControls() {
        const run = panel.querySelector("#aiya-run");
        if (run) {
            run.textContent = running ? "停止" : "开始处理";
        }
    }

    function renderQueue() {
        const box = panel.querySelector("#aiya-queue");
        if (!box) {
            return;
        }
        box.innerHTML = "";
        if (queue.length === 0) {
            box.innerHTML = '<div style="color:#999;padding:6px 2px">队列为空：在发帖器里给已上线行添加空链接的网盘组后点「刷新队列」。</div>';
            return;
        }
        queue.forEach((item, index) => {
            const row = document.createElement("div");
            row.style.cssText = "padding:5px 2px;border-bottom:1px solid #f2f2f2";
            const color = item.status === "done" ? "#2e7d32" : item.status === "fail" ? "#c62828" : item.status === "run" ? "#1565c0" : "#666";
            row.innerHTML =
                `<div style="display:flex;gap:6px;align-items:baseline">` +
                `<b style="flex:none">${item.dirName}</b>` +
                `<span style="color:#888;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">组 #${item.groupId} · ${item.groupTitle}</span>` +
                `<button data-aiya-act="process-one" data-aiya-arg="${index}" style="flex:none;cursor:pointer">处理</button></div>` +
                `<div style="color:${color};white-space:normal">${item.statusText ?? "待处理"}</div>`;
            box.appendChild(row);
        });
    }

    function renderPanel() {
        panel.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #eee">
                <b>AIYA 网盘回填</b>
            </div>
            <div style="padding:8px 10px;display:flex;flex-direction:column;gap:6px">
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
                    <button id="aiya-refresh" data-aiya-act="refresh" style="cursor:pointer">刷新队列</button>
                    <button id="aiya-run" data-aiya-act="run" style="cursor:pointer">开始处理</button>
                    <span id="aiya-msg" style="color:#888;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis"></span>
                </div>
                <div id="aiya-queue" style="max-height:260px;overflow:auto"></div>
            </div>`;
        const root = panel.querySelector("#aiya-root");
        root.onchange = (event) => {
            cfg.rootDir = event.target.value.trim() || "/";
            saveCfg();
            bdstoken = null;
        };
        const pub = panel.querySelector("#aiya-pub");
        pub.onchange = (event) => {
            cfg.publisher = event.target.value.trim().replace(/\/+$/, "");
            saveCfg();
            renderHookText();
        };
        const period = panel.querySelector("#aiya-period");
        period.value = cfg.period;
        period.onchange = (event) => {
            cfg.period = event.target.value;
            saveCfg();
        };
        renderQueue();
        renderControls();
    }

    function setMsg(text) {
        const msg = panel.querySelector("#aiya-msg");
        if (msg) {
            msg.textContent = text;
        }
    }

    function refreshQueue() {
        return publisherFetch(`/api/netdisk/queue?netdisk=${encodeURIComponent(PIPELINE)}`)
            .then((data) => {
                queue = data.queue.map((item) => ({ ...item }));
                renderQueue();
                setMsg(`队列已刷新：${queue.length} 条待处理`);
            })
            .catch((error) => {
                setMsg(String(error.message ?? error));
            });
    }

    function showPanel() {
        panel.style.display = "block";
        void refreshQueue();
    }

    function hidePanel() {
        panel.style.display = "none";
    }

    // ---------- 挂钩：LOGO 后的纯文本，直接显示发帖器状态 --------------------
    let online = null; // null = 检测中

    function renderHookText() {
        const hook = document.getElementById("aiya-hook");
        if (!hook) {
            return;
        }
        const state = running ? "处理中" : online === null ? "检测中" : online ? "已连接" : "未连接";
        hook.textContent = `${publisherHost()} - ${state}`;
        hook.title = online ? `本机发帖器：${state}` : "正在探测本机发帖器…";
    }

    function refreshPublisherStatus() {
        publisherFetch("/api/netdisk/queue")
            .then(() => {
                online = true;
            })
            .catch(() => {
                online = false;
            })
            .finally(() => {
                renderHookText();
            });
    }

    function buildHook() {
        const hook = document.createElement("div");
        hook.id = "aiya-hook";
        // space-between distributes spare space around every extra flex
        // child (the hook rendered mid-bar); the auto right margin soaks the
        // free space up so the hook hugs the LOGO.
        hook.style.cssText = [
            "cursor:pointer", "flex:none", "margin-left:10px", "margin-right:auto",
            "padding:4px 2px", "font-size:13px", "color:#333", "user-select:none",
        ].join(";");
        hook.setAttribute("data-aiya-act", "toggle");
        return hook;
    }

    function mountHook() {
        if (document.getElementById("aiya-hook")) {
            return;
        }
        const header = document.querySelector(".wp-s-header");
        const left = header?.querySelector(".wp-s-header__left") ?? null;
        const hook = buildHook();
        if (left) {
            // The header is a flex row (left / center / right): become its
            // second child so the hook sits right after the LOGO block.
            left.insertAdjacentElement("afterend", hook);
        } else {
            // Page redesign fallback: a fixed button that stays readable.
            hook.style.cssText += ";position:fixed;right:16px;top:12px;z-index:2147483000;background:#fff;border:1px solid #ddd;padding:6px 12px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.15)";
            document.body.appendChild(hook);
        }
        renderHookText();
        refreshPublisherStatus();
    }

    // ---------- 事件分派（window 捕获阶段，页面无法吞掉我们的点击） -----------
    // Big SPAs register document-level capture handlers that can swallow
    // synthetic clicks; window captures BEFORE document, so our subtree is
    // dispatched here and the page never sees those events.
    function dispatchAct(act, arg) {
        switch (act) {
            case "toggle":
                panel.style.display === "block" ? hidePanel() : showPanel();
                break;
            case "refresh":
                void refreshQueue();
                break;
            case "run":
                if (running) {
                    running = false;
                    renderControls();
                } else {
                    void runQueue();
                }
                break;
            case "process-one": {
                const item = queue[Number(arg)];
                if (!item || running) {
                    return;
                }
                setStatus(item, "", "待处理");
                running = true;
                renderHookText();
                processItem(item)
                    .catch((error) => setStatus(item, "fail", String(error.message ?? error)))
                    .finally(() => {
                        running = false;
                        renderHookText();
                        renderControls();
                    });
                break;
            }
        }
    }

    window.addEventListener(
        "click",
        (event) => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target || !target.closest("#aiya-netdisk-panel, #aiya-hook")) {
                return;
            }
            const act = target.closest("[data-aiya-act]");
            if (act) {
                event.preventDefault();
                event.stopPropagation();
                dispatchAct(act.getAttribute("data-aiya-act"), act.getAttribute("data-aiya-arg") ?? undefined);
            }
        },
        true,
    );

    // A plain bubble: any mousedown outside hook + panel hides it.
    window.addEventListener(
        "mousedown",
        (event) => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target) {
                return;
            }
            if (target.closest("#aiya-netdisk-panel") || target.closest("#aiya-hook")) {
                return;
            }
            if (panel.style.display === "block") {
                hidePanel();
            }
        },
        true,
    );

    const mount = () => {
        document.body.appendChild(panel);
        renderPanel();
        mountHook();
        setInterval(mountHook, 2000);
        setInterval(refreshPublisherStatus, 15000);
    };
    if (document.body) {
        mount();
    } else {
        window.addEventListener("DOMContentLoaded", mount);
    }
})();
