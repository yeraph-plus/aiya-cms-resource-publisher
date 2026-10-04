import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import type { StateDTO } from "./types";
import Grid from "./components/Grid";
import Detail from "./components/Detail";
import SettingsPanel from "./components/SettingsPanel";
import ImportPanel from "./components/ImportPanel";
import LogConsole from "./components/LogConsole";

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
    const [importOpen, setImportOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState<Toast | null>(null);
    const [revision, setRevision] = useState(0);
    // Bumped after every operation so the log console catches up instantly
    // instead of waiting for its poll tick.
    const [logTick, setLogTick] = useState(0);
    // Progress of the running pull/push, polled while busy; null when idle.
    const [progress, setProgress] = useState<api.ProgressDTO | null>(null);
    // Right panel width, persisted across sessions; draggable via the divider.
    const [detailWidth, setDetailWidth] = useState<number>(() => {
        const stored = Number(window.localStorage.getItem("publisher.detailWidth"));
        return Number.isFinite(stored) && stored >= 320 && stored <= 960 ? stored : 480;
    });
    const [dragging, setDragging] = useState(false);
    const widthRef = useRef(detailWidth);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const startDrag = (event: React.PointerEvent) => {
        event.preventDefault();
        setDragging(true);
        const move = (moveEvent: PointerEvent) => {
            const max = Math.max(320, Math.min(960, window.innerWidth - 480));
            const width = Math.min(Math.max(320, window.innerWidth - moveEvent.clientX), max);
            widthRef.current = width;
            setDetailWidth(width);
        };
        const up = () => {
            setDragging(false);
            window.localStorage.setItem("publisher.detailWidth", String(widthRef.current));
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };

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
            } catch (error) {
                // Network-layer rejections (server unreachable etc.) would
                // otherwise vanish as unhandled rejections with no feedback.
                notify("err", `操作失败：${String(error)}`);
            } finally {
                setBusy(false);
                setLogTick((tick) => tick + 1);
            }
        },
        [notify],
    );

    // While an operation runs, poll the server's progress slot so the header
    // spinner carries a live phase label and a percentage instead of looking
    // frozen. Cleared as soon as the operation settles.
    useEffect(() => {
        if (!busy) {
            setProgress(null);
            return;
        }
        let alive = true;
        const tick = async () => {
            try {
                const next = await api.fetchProgress();
                if (alive) {
                    setProgress(next);
                }
            } catch {
                // transient polling failure — keep the last snapshot
            }
        };
        void tick();
        const timer = setInterval(tick, 400);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [busy]);

    const onSync = () =>
        withBusy(async () => {
            const outcome = await api.sync();
            if (!outcome.ok) {
                notify("err", `拉取失败：${outcome.error}`);
            } else {
                notify(
                    "ok",
                    `拉取完成：获取 ${outcome.fetched} 条，新增 ${outcome.created}，刷新 ${outcome.refreshed}，冲突 ${outcome.conflicts}，线上缺失 ${outcome.missing}` +
                        (outcome.skipped > 0 ? `，跳过畸形 ${outcome.skipped} 条` : ""),
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

    const onCompletionPush = (localIds?: number[]) =>
        withBusy(async () => {
            const outcome = await api.pushCompletion(localIds);
            if (outcome.error) {
                notify("err", `补完推送失败：${outcome.error}`);
            } else if (outcome.failed > 0) {
                notify("err", `补完推送：成功 ${outcome.pushed}，失败 ${outcome.failed}（${outcome.errors[0]?.message ?? ""}）`);
            } else if (outcome.pushed === 0) {
                notify("ok", "补完推送：没有可推送的行（文件列表都还没填链接，或都已推送过）。");
            } else {
                notify("ok", `补完推送完成：${outcome.pushed} 行的文件列表已写入站点`);
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

    // Hooks must run on every render: state is null until the first
    // /api/state round-trip, so the loading branch has to come after them.
    const rows = useMemo(
        () =>
            (state?.posts ?? []).filter((row) => {
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
            }),
        [state, filter],
    );

    if (!state) {
        return <div className="h-full grid place-items-center text-neutral-500">正在读取本地库…</div>;
    }

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
                <span className="flex items-center gap-2">
                    <select value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
                        <option value="all">全部（{state.posts.length}）</option>
                        <option value="dirty">待推送</option>
                        <option value="conflict">冲突</option>
                        <option value="new">未推送新行</option>
                        <option value="missing">线上缺失</option>
                    </select>
                    <button className="btn" disabled={busy} onClick={() => setSettingsOpen(true)}>
                        设置
                    </button>
                </span>
                <span className="pl-2 border-l border-neutral-200 flex items-center gap-2">
                    <button className="btn" disabled={busy} onClick={onSync}>
                        拉取
                    </button>
                    <button className="btn btn-primary" disabled={busy || dirtyCount === 0} onClick={() => onPush()}>
                        推送（{dirtyCount}）
                    </button>
                    <button className="btn" disabled={busy} onClick={() => onCompletionPush()}>
                        补完推送
                    </button>
                </span>
                <span className="pl-2 border-l border-neutral-200 flex items-center gap-2">
                    <button className="btn" disabled={busy} onClick={onNew}>
                        新建行
                    </button>
                    <button className="btn" disabled={busy} onClick={() => setImportOpen(true)}>
                        导入 CSV
                    </button>
                </span>
                <span className="pl-2 border-l border-neutral-200 flex items-center gap-2">
                    <button
                        className="btn"
                        disabled={busy || !selected || !selected.dirty}
                        onClick={() => selected && onPush([selected.localId])}
                    >
                        推送此行
                    </button>
                    <button
                        className="btn"
                        disabled={busy || !selected}
                        onClick={() => selected && onRevert(selected.localId)}
                    >
                        还原到快照
                    </button>
                    <button
                        className="btn text-red-600"
                        disabled={busy || !selected}
                        onClick={() => selected && onDelete(selected.localId)}
                    >
                        删除本地行
                    </button>
                </span>
                {busy && (
                    <span className="ml-auto flex items-center gap-2 min-w-0">
                        <span className="w-3.5 h-3.5 rounded-full border-2 border-neutral-300 border-t-blue-600 animate-spin shrink-0" />
                        {progress && progress.total > 0 ? (
                            <span className="flex items-center gap-1.5 min-w-0">
                                <span className="text-xs text-neutral-500 truncate max-w-44">{progress.phase}</span>
                                <span className="w-28 h-1.5 rounded bg-neutral-200 overflow-hidden shrink-0">
                                    <span
                                        className="block h-full bg-blue-600 transition-all duration-200"
                                        style={{ width: `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%` }}
                                    />
                                </span>
                                <span className="text-xs text-neutral-500 tabular-nums shrink-0">
                                    {Math.min(100, Math.round((progress.done / progress.total) * 100))}%
                                </span>
                            </span>
                        ) : (
                            <span className="text-xs text-neutral-500 truncate">{progress?.phase ?? "处理中"}</span>
                        )}
                    </span>
                )}
            </header>

            {settingsOpen && (
                <SettingsPanel
                    state={state}
                    onClose={() => setSettingsOpen(false)}
                    onSaved={async (message) => {
                        notify(message.kind, message.text);
                        await refresh();
                    }}
                />
            )}

            {importOpen && (
                <ImportPanel
                    state={state}
                    onClose={() => setImportOpen(false)}
                    onDone={async (message) => {
                        notify(message.kind, message.text);
                        await refresh();
                    }}
                />
            )}

            <div className={`flex-1 flex min-h-0 ${dragging ? "select-none" : ""}`}>
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
                <div
                    className={`w-1 shrink-0 cursor-col-resize transition-colors ${
                        dragging ? "bg-blue-400" : "bg-neutral-200 hover:bg-blue-300"
                    }`}
                    onPointerDown={startDrag}
                    title="拖动调整编辑栏宽度"
                />
                <aside
                    style={{ width: detailWidth }}
                    className="shrink-0 bg-white flex flex-col min-h-0 border-l border-neutral-200"
                >
                    {selected ? (
                        <div className="flex-1 overflow-y-auto min-h-0">
                            <Detail
                                key={`${selected.localId}:${revision}`}
                                row={selected}
                                state={state}
                                busy={busy}
                                onEdit={onSaved}
                                notify={notify}
                            />
                        </div>
                    ) : (
                        <div className="flex-1 grid place-items-center text-sm text-neutral-400 px-6 text-center">
                            在左侧选择一行查看与编辑。
                        </div>
                    )}
                </aside>
            </div>

            <LogConsole refreshKey={logTick} />

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
