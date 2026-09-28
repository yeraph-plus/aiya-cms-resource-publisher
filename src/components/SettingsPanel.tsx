import { useState } from "react";
import * as api from "../api";
import type { StateDTO } from "../types";

interface Props {
    state: StateDTO;
    onSaved: (message: { kind: "ok" | "err"; text: string }) => Promise<void>;
}

export default function SettingsPanel({ state, onSaved }: Props) {
    const [siteUrl, setSiteUrl] = useState(state.settings.siteUrl);
    const [username, setUsername] = useState(state.settings.username);
    const [appPassword, setAppPassword] = useState("");
    const [defaultAuthorId, setDefaultAuthorId] = useState<number | null>(state.settings.defaultAuthorId);
    const [busy, setBusy] = useState(false);

    const saveAndConnect = async () => {
        setBusy(true);
        try {
            await api.saveSettings({
                siteUrl,
                username,
                ...(appPassword.trim() !== "" ? { appPassword: appPassword.trim() } : {}),
                defaultAuthorId,
            });
            const result = await api.connect();
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
            await onSaved({ kind: "err", text: `保存失败：${String(error)}` });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="bg-neutral-50 border-b border-neutral-200 px-4 py-3 grid grid-cols-[auto_1fr_auto] gap-x-2 gap-y-2 items-center">
            <label className="text-right text-neutral-500">站点地址</label>
            <input value={siteUrl} onChange={(event) => setSiteUrl(event.target.value)} placeholder="http://localhost:8000" />
            <span />

            <label className="text-right text-neutral-500">用户名</label>
            <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="应用密码所属的账号" />
            <span />

            <label className="text-right text-neutral-500">应用密码</label>
            <input
                type="password"
                value={appPassword}
                onChange={(event) => setAppPassword(event.target.value)}
                placeholder={state.settings.hasPassword ? "已保存（留空保持不变）" : "WP 后台 → 用户 → 应用密码 生成"}
            />
            <span />

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
            <span />

            <span />
            <div className="flex items-center gap-2">
                <button className="btn btn-primary" disabled={busy} onClick={saveAndConnect}>
                    保存并测试连接
                </button>
                <span className="text-xs text-neutral-400">
                    应用密码只保存在本机 SQLite（publisher.db）。编辑/管理员级账号可代发任意作者。
                </span>
            </div>
        </div>
    );
}
