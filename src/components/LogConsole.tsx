import { useCallback, useEffect, useRef, useState } from "react";
import { clearLogs, fetchLogs } from "../api";
import type { LogDTO } from "../types";

const LEVEL_CLASS: Record<string, string> = {
    error: "text-red-500",
    warn: "text-amber-500",
    info: "text-neutral-600",
};

/**
 * The tool's operational log (底部日志区): server-side events streamed
 * incrementally by id. The buffer keeps the newest 500 lines client-side;
 * auto-scroll only while the reader sits at the bottom.
 */
export default function LogConsole({ refreshKey }: { refreshKey: number }) {
    const [logs, setLogs] = useState<LogDTO[]>([]);
    const [open, setOpen] = useState(true);
    const [clearing, setClearing] = useState(false);
    const lastIdRef = useRef(0);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const pinnedRef = useRef(true);

    const pull = useCallback(async () => {
        try {
            const result = await fetchLogs(lastIdRef.current);
            if (result.logs.length > 0) {
                lastIdRef.current = result.logs[result.logs.length - 1]!.id;
                setLogs((prev) => [...prev, ...result.logs].slice(-500));
            }
        } catch {
            // Transient (server restarting) — the next poll retries.
        }
    }, []);

    useEffect(() => {
        void pull();
        const timer = setInterval(pull, 5000);
        return () => clearInterval(timer);
    }, [pull]);

    // An operation just finished — catch up immediately instead of waiting
    // for the next poll tick.
    useEffect(() => {
        if (refreshKey > 0) {
            void pull();
        }
    }, [refreshKey, pull]);

    useEffect(() => {
        if (pinnedRef.current && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [logs, open]);

    const onClear = () => {
        void (async () => {
            setClearing(true);
            try {
                await clearLogs();
                setLogs([]);
            } catch {
                // Leave the view as-is; the next poll reconciles.
            } finally {
                setClearing(false);
            }
        })();
    };

    return (
        <div className="border-t border-neutral-200 bg-neutral-50">
            <div className="flex items-center gap-2 px-3 py-1 text-xs text-neutral-500">
                <button className="hover:text-neutral-800" onClick={() => setOpen((value) => !value)}>
                    {open ? "▾" : "▸"} 运行日志
                </button>
                <span className="tabular-nums">{logs.length} 条</span>
                <button
                    className="ml-auto hover:text-red-500 disabled:opacity-40"
                    disabled={clearing || logs.length === 0}
                    onClick={onClear}
                >
                    清空
                </button>
            </div>
            {open && (
                <div
                    ref={scrollRef}
                    onScroll={(event) => {
                        const el = event.currentTarget;
                        pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                    }}
                    className="h-44 overflow-y-auto px-3 pb-2 font-mono text-[11px] leading-4"
                >
                    {logs.length === 0 ? (
                        <div className="text-neutral-300">暂无日志</div>
                    ) : (
                        logs.map((entry) => (
                            <div key={entry.id} className={LEVEL_CLASS[entry.level] ?? "text-neutral-600"}>
                                <span className="tabular-nums text-neutral-400">
                                    {new Date(entry.ts).toLocaleTimeString("zh-CN", { hour12: false })}
                                </span>{" "}
                                <span className="text-neutral-400">[{entry.scope}]</span>
                                {entry.ref !== null && <span className="text-neutral-400"> #{entry.ref}</span>} {entry.message}
                            </div>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
