import { useEffect, useState } from "react";
import * as api from "../api";
import type { StateDTO } from "../types";

interface Props {
    state: StateDTO;
    onClose: () => void;
    onSaved: (message: { kind: "ok" | "err"; text: string }) => Promise<void>;
}

export default function SettingsPanel({ state, onClose, onSaved }: Props) {
    const [siteUrl, setSiteUrl] = useState(state.settings.siteUrl);
    const [username, setUsername] = useState(state.settings.username);
    const [appPassword, setAppPassword] = useState("");
    const [proxyUrl, setProxyUrl] = useState(state.settings.proxyUrl);
    const [defaultAuthorId, setDefaultAuthorId] = useState<number | null>(state.settings.defaultAuthorId);
    const [workRoot, setWorkRoot] = useState(state.settings.workRoot);
    const [dirNameMode, setDirNameMode] = useState(state.settings.dirNameMode);
    const [fileserveTemplate, setFileserveTemplate] = useState(state.settings.fileserveTemplate ?? "");
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onClose();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const typedValues = () => ({
        siteUrl,
        username,
        ...(appPassword.trim() !== "" ? { appPassword: appPassword.trim() } : {}),
        proxyUrl,
        defaultAuthorId,
        workRoot,
        dirNameMode,
        fileserveTemplate: fileserveTemplate.trim() === "" ? null : fileserveTemplate,
    });

    const save = async () => {
        if (fileserveTemplate.trim() !== "") {
            try {
                JSON.parse(fileserveTemplate);
            } catch {
                await onSaved({ kind: "err", text: "组模板不是可读的 JSON。" });
                return;
            }
        }
        setBusy(true);
        try {
            await api.saveSettings(typedValues());
            await onSaved({ kind: "ok", text: "设置已保存。" });
            onClose();
        } catch (error) {
            await onSaved({ kind: "err", text: `保存失败：${String(error)}` });
        } finally {
            setBusy(false);
        }
    };

    const test = async () => {
        setBusy(true);
        try {
            const result = await api.connect(typedValues());
            if (result.ok && result.ping) {
                const caps = result.ping.caps;
                const hints: string[] = [];
                if (!caps.publishPosts) hints.push("无 publish_posts（只能存草稿）");
                if (!caps.editOthersPosts) hints.push("无 edit_others_posts（不能代发）");
                await onSaved({
                    kind: hints.length > 0 ? "err" : "ok",
                    text: `连接成功：${result.ping.user.name}（v${result.ping.version}）${hints.length > 0 ? " · " + hints.join("、") : ""}`,
                });
            } else {
                await onSaved({ kind: "err", text: `连接失败：${result.error}` });
            }
        } catch (error) {
            await onSaved({ kind: "err", text: `连接失败：${String(error)}` });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 bg-black/40 grid place-items-center"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <div className="bg-white rounded-lg shadow-xl w-[560px] max-w-[92vw] max-h-[90vh] overflow-y-auto">
                <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-200">
                    <span className="font-semibold">设置</span>
                    <button className="text-neutral-400 hover:text-neutral-700 text-lg leading-none" onClick={onClose}>
                        ×
                    </button>
                </div>

                <div className="px-5 py-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-3 items-center">
                    <label className="text-right text-neutral-500">站点地址</label>
                    <input value={siteUrl} onChange={(event) => setSiteUrl(event.target.value)} placeholder="http://localhost:8000" />

                    <label className="text-right text-neutral-500">用户名</label>
                    <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="应用密码所属的账号" />

                    <label className="text-right text-neutral-500">应用密码</label>
                    <input
                        type="password"
                        value={appPassword}
                        onChange={(event) => setAppPassword(event.target.value)}
                        placeholder={state.settings.hasPassword ? "已保存（留空保持不变）" : "WP 后台 → 用户 → 应用密码 生成"}
                    />

                    <label className="text-right text-neutral-500">HTTP 代理</label>
                    <input
                        value={proxyUrl}
                        onChange={(event) => setProxyUrl(event.target.value)}
                        placeholder="http://127.0.0.1:7890（可空；支持 user:pass@host:port）"
                    />

                    <label className="text-right text-neutral-500">新行默认作者</label>
                    <select
                        value={defaultAuthorId ?? ""}
                        onChange={(event) => setDefaultAuthorId(event.target.value === "" ? null : Number(event.target.value))}
                    >
                        <option value="">（推送后由站点定为当前账号）</option>
                        {state.authors.map((author) => (
                            <option key={author.id} value={author.id}>
                                {author.name}（#{author.id}）
                            </option>
                        ))}
                    </select>

                    <label className="text-right text-neutral-500">补完工作目录</label>
                    <input
                        value={workRoot}
                        onChange={(event) => setWorkRoot(event.target.value)}
                        placeholder="文件补完的根目录，如 D:\\网盘发布（可空 = 不启用补完流程）"
                    />

                    <label className="text-right text-neutral-500">目录命名</label>
                    <select value={dirNameMode} onChange={(event) => setDirNameMode(event.target.value)}>
                        <option value="id">文章 ID（推荐，最稳）</option>
                        <option value="id-slug">ID-slug（ID-别名，更易读）</option>
                        <option value="slug">文章别名（需站点 slug 为 ASCII）</option>
                    </select>

                    <label className="text-right text-neutral-500 self-start pt-1">补完组模板</label>
                    <textarea
                        className="font-mono text-xs leading-5"
                        rows={4}
                        value={fileserveTemplate}
                        onChange={(event) => setFileserveTemplate(event.target.value)}
                        placeholder={'留空 = 默认（百度网盘 + 夸克网盘，价格 0）。JSON 数组，如：\n[{"netdisk":"baidu","title":"百度网盘","price":2},{"netdisk":"quark","title":"夸克网盘","price":0}]'}
                    />
                </div>

                <div className="px-5 pb-5">
                    <div className="flex items-center gap-2">
                        <button className="btn btn-primary" disabled={busy} onClick={save}>
                            保存
                        </button>
                        <button className="btn" disabled={busy} onClick={test}>
                            测试连接
                        </button>
                    </div>
                    <p className="mt-2 text-xs text-neutral-400">
                        测试连接用的是表单当前值，不会先保存。作者列表在「同步」时从站点拉取（可发帖的账号）。
                    </p>
                </div>
            </div>
        </div>
    );
}
