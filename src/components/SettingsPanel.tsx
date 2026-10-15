import { useEffect, useState } from "react";
import * as api from "../api";
import type { StateDTO } from "../types";
import { NETDISK_OPTIONS, parseNetdiskTodo } from "../../shared/fileserve";

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
    const [dirNameSuffix, setDirNameSuffix] = useState(state.settings.dirNameSuffix);
    const [newRowStatus, setNewRowStatus] = useState(state.settings.newRowStatus);
    const [netdiskTodoEnabled, setNetdiskTodoEnabled] = useState(state.settings.netdiskTodoEnabled);
    const [netdiskTodo, setNetdiskTodo] = useState<string[]>(parseNetdiskTodo(state.settings.netdiskTodoGroups));
    const [busy, setBusy] = useState(false);

    const toggleNetdisk = (id: string) => {
        setNetdiskTodo((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
    };

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
        dirNameSuffix,
        newRowStatus,
        netdiskTodoEnabled,
        netdiskTodoGroups: netdiskTodo.join(","),
    });

    const save = async () => {
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

                    <label className="text-right text-neutral-500">本地目录创建根</label>
                    <input
                        value={workRoot}
                        onChange={(event) => setWorkRoot(event.target.value)}
                        placeholder="本地目录辅助的根位置，如 D:\\网盘发布（可空 = 不自动创建；网盘回填不依赖它）"
                    />

                    <label className="text-right text-neutral-500">目录命名</label>
                    <select value={dirNameSuffix} onChange={(event) => setDirNameSuffix(event.target.value)}>
                        <option value="slug">ID-SLUG</option>
                        <option value="title">ID-标题</option>
                        <option value="none">仅 ID</option>
                    </select>
                    <span className="col-span-2 text-xs text-neutral-500">
                        只作用于本地暂存目录：ID-SLUG 取线上 permalink 末段，没有 slug 的行回落标题（历史行要重新同步才会有 slug）。网盘目录由油猴脚本固定用 CA+补零6位ID，不跟随这里。
                    </span>

                    <label className="text-right text-neutral-500">新行默认状态</label>
                    <select value={newRowStatus} onChange={(event) => setNewRowStatus(event.target.value)}>
                        <option value="draft">草稿（先入队，等网盘回填再一起推送）</option>
                        <option value="publish">发布（推送时直接发布）</option>
                    </select>

                    <label className="text-right text-neutral-500">挂网盘待办组</label>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <label className="inline-flex items-center gap-1 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={netdiskTodoEnabled}
                                onChange={(event) => setNetdiskTodoEnabled(event.target.checked)}
                            />
                            <span>新建行自动挂上</span>
                        </label>
                        {NETDISK_OPTIONS.map((option) => (
                            <label key={option.id} className="inline-flex items-center gap-1 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={netdiskTodo.includes(option.id)}
                                    disabled={!netdiskTodoEnabled}
                                    onChange={() => toggleNetdisk(option.id)}
                                />
                                <span>{option.label}</span>
                            </label>
                        ))}
                    </div>
                    <span className="col-span-2 text-xs text-neutral-500">
                        只挂「空链接」的网盘组，不随推送上行——推送会过滤掉空链接组，所以不会发出无效下载项；等网盘脚本回填后由你在表格里点推送。覆盖 智能摄取 入队、CSV 导入 与「新建行」三条新建路径。
                    </span>
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
