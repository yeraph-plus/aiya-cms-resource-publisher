import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import type { StateDTO } from "./types";
import Grid from "./components/Grid";
import Detail from "./components/Detail";
import SettingsPanel from "./components/SettingsPanel";

export type Filter = "all" | "dirty" | "conflict" | "new" | "missing";

interface Toast {
    kind: "ok" | "err";
    text: string;
}

export default function App() {
    const [state, setState] = useState<StateDTO | null>(null);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [filter, setFilter] = useState<Filter>("all");
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState<Toast | null>(null);
    const [revision, setRevision] = useState(0);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const notify = useCallback((kind: "ok" | "err", text: string) => {
        setToast({ kind, text });
        if (toastTimer.current) {
            clearTimeout(toastTimer.current);
        }
        toastTimer.current = setTimeout(() => setToast(null), 4000);
    }, []);

    const refresh = useCallback(async () => {
        try {
            const next = await api.fetchState();
            setState(next);
            return next;
        } catch (error) {
            notify("err", `读取本地状态失败：${String(error)}`);
            return null;
        }
    }, [notify]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const withBusy = useCallback(
        async (task: () => Promise<void>) => {
            setBusy(true);
            try {
                await task();
            } finally {
                setBusy(false);
            }
        },
        [],
    );

    const onSync = () =>
        withBusy(async () => {
            const outcome = await api.sync();
            if (!outcome.ok) {
                notify("err", `同步失败：${outcome.error}`);
            } else {
                notify(
                    "ok",
                    `同步完成：拉取 ${outcome.fetched} 条，新增 ${outcome.created}，刷新 ${outcome.refreshed}，冲突 ${outcome.conflicts}，线上缺失 ${outcome.missing}`,
                );
            }
            await refresh();
        });

    const onPush = (localIds?: number[]) =>
        withBusy(async () => {
            const outcome = await api.push(localIds);
            if (outcome.error) {
                notify("err", `推送失败：${outcome.error}`);
            } else if (outcome.failed > 0) {
                notify("err", `推送完成：成功 ${outcome.pushed}，失败 ${outcome.failed}（详情见行内错误）`);
            } else {
                notify("ok", `推送完成：${outcome.pushed} 条已写入站点`);
            }
            await refresh();
        });

    const onNew = () =>
        withBusy(async () => {
            const localId = await api.createRow();
            await refresh();
            setSelectedId(localId);
        });

    const onDelete = (localId: number) =>
        withBusy(async () => {
            await api.deleteRow(localId);
            if (selectedId === localId) {
                setSelectedId(null);
            }
            notify("ok", "已删除本地行（线上帖子不受影响）");
            await refresh();
        });

    const onRevert = (localId: number) =>
        withBusy(async () => {
            try {
                await api.revertRow(localId);
                setRevision((r) => r + 1);
                notify("ok", "已还原到最近一次确认的状态");
            } catch (error) {
                notify("err", String(error));
            }
            await refresh();
        });

    const onSaved = useCallback(() => {
        void refresh();
    }, [refresh]);

    if (!state) {
        return <div className="h-full grid place-items-center text-neutral-500">正在读取本地库…</div>;
    }

    const rows = state.posts.filter((row) => {
        switch (filter) {
            case "dirty":
                return row.dirty;
            case "conflict":
                return row.conflict;
            case "new":
                return row.postId === null;
            case "missing":
                return row.missing;
            default:
                return true;
        }
    });

    const selected = state.posts.find((row) => row.localId === selectedId) ?? null;
    const dirtyCount = state.posts.filter((row) => row.dirty).length;
    const connected = state.settings.hasPassword && state.settings.siteUrl !== "" && state.settings.username !== "";

    return (
        <div className="h-full flex flex-col min-h-0">
            <header className="bg-white border-b border-neutral-200 px-4 py-2 flex flex-wrap items-center gap-2">
                <span className="font-semibold mr-2">AIYA 发帖器</span>
                <span
                    className={`px-2 py-0.5 rounded-full text-xs ${
                        connected ? "bg-green-100 text-green-700" : "bg-neutral-200 text-neutral-600"
                    }`}
                >
                    {connected ? `${state.settings.siteUrl} · ${state.settings.username}` : "未配置站点"}
                </span>
                <button className="btn" disabled={busy} onClick={onSync}>
                    同步
                </button>
                <button className="btn btn-primary" disabled={busy || dirtyCount === 0} onClick={() => onPush()}>
                    推送全部（{dirtyCount}）
                </button>
                <button className="btn" disabled={busy} onClick={onNew}>
                    新建行
                </button>
                <select className="ml-auto" value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
                    <option value="all">全部（{state.posts.length}）</option>
                    <option value="dirty">待推送</option>
                    <option value="conflict">冲突</option>
                    <option value="new">未推送新行</option>
                    <option value="missing">线上缺失</option>
                </select>
                <button className="btn" onClick={() => setSettingsOpen((open) => !open)}>
                    设置
                </button>
            </header>

            {settingsOpen && (
                <SettingsPanel
                    state={state}
                    onSaved={async (message) => {
                        notify(message.kind, message.text);
                        await refresh();
                    }}
                />
            )}

            <div className="flex-1 flex min-h-0">
                <div className="flex-1 min-w-0 p-2">
                    <Grid
                        rows={rows}
                        terms={state.terms}
                        authors={state.authors}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                        onEdit={(localId, patch) => {
                            void withBusy(async () => {
                                try {
                                    await api.saveRow(localId, patch);
                                    await refresh();
                                } catch (error) {
                                    notify("err", String(error));
                                }
                            });
                        }}
                    />
                </div>
                {selected && (
                    <aside className="w-[460px] shrink-0 border-l border-neutral-200 bg-white overflow-y-auto">
                        <Detail
                            key={`${selected.localId}:${revision}`}
                            row={selected}
                            state={state}
                            busy={busy}
                            onEdit={onSaved}
                            onPushRow={() => onPush([selected.localId])}
                            onRevert={() => onRevert(selected.localId)}
                            onDelete={() => onDelete(selected.localId)}
                            notify={notify}
                        />
                    </aside>
                )}
            </div>

            {toast && (
                <div
                    className={`fixed bottom-4 right-4 px-4 py-2 rounded shadow-lg text-sm ${
                        toast.kind === "ok" ? "bg-green-600 text-white" : "bg-red-600 text-white"
                    }`}
                >
                    {toast.text}
                </div>
            )}
        </div>
    );
}
