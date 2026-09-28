import { useEffect, useMemo, useRef, useState } from "react";
import type { RowDTO, StateDTO } from "../types";
import { TAXONOMY_LABELS, TAXONOMY_ORDER } from "../types";
import type { RowPatch } from "../api";
import FileServeEditor from "./FileServeEditor";
import { normalizeConfig, type FileServeConfig } from "../../shared/fileserve";

interface Props {
    row: RowDTO;
    state: StateDTO;
    busy: boolean;
    onEdit: () => void;
    onPushRow: () => void;
    onRevert: () => void;
    onDelete: () => void;
    notify: (kind: "ok" | "err", text: string) => void;
}

/** '2020-05-06T07:08:00' → datetime-local value; '' stays empty. */
function toInput(value: string): string {
    return value === "" ? "" : value.slice(0, 16);
}

function fromInput(value: string): string {
    return value === "" ? "" : `${value}:00`;
}

interface Draft {
    status: string;
    title: string;
    content: string;
    authorId: number | null;
    dateLocal: string;
    terms: Record<string, string[]>;
    fileserve: FileServeConfig | null;
}

export default function Detail({ row, state, busy, onEdit, onPushRow, onRevert, onDelete, notify }: Props) {
    const [draft, setDraft] = useState<Draft>(() => ({
        status: row.status,
        title: row.title,
        content: row.content,
        authorId: row.authorId,
        dateLocal: toInput(row.dateLocal),
        terms: row.terms,
        fileserve: (row.fileserveParsed ?? null) as FileServeConfig | null,
    }));
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        return () => {
            if (timer.current) {
                clearTimeout(timer.current);
            }
        };
    }, []);

    const save = (next: Draft) => {
        if (timer.current) {
            clearTimeout(timer.current);
        }
        timer.current = setTimeout(async () => {
            try {
                const { config } = normalizeConfig(next.fileserve);
                const payload: RowPatch = {
                    status: next.status,
                    title: next.title,
                    content: next.content,
                    authorId: next.authorId,
                    dateLocal: next.dateLocal === "" ? "" : `${next.dateLocal}:00`,
                    terms: next.terms,
                    fileserve: Object.keys(config).length > 0 ? config : next.fileserve === null ? null : {},
                };
                await import("../api").then((api) => api.saveRow(row.localId, payload));
                onEdit();
            } catch (error) {
                notify("err", `保存失败：${String(error)}`);
            }
        }, 600);
    };

    const update = (patch: Partial<Draft>) => {
        setDraft((previous) => {
            const next = { ...previous, ...patch };
            save(next);
            return next;
        });
    };

    const termOptions = useMemo(
        () => (taxonomy: string) => state.terms[taxonomy] ?? [],
        [state.terms],
    );

    const addTerm = (taxonomy: string, raw: string) => {
        const name = raw.trim();
        if (name === "") {
            return;
        }
        const existing = termOptions(taxonomy).find((option) => option.name.toLowerCase() === name.toLowerCase());
        const ref = existing ? String(existing.id) : `name:${name}`;
        const current = draft.terms[taxonomy] ?? [];
        if (current.includes(ref)) {
            return;
        }
        update({ terms: { ...draft.terms, [taxonomy]: [...current, ref] } });
    };

    const removeTerm = (taxonomy: string, ref: string) => {
        const current = draft.terms[taxonomy] ?? [];
        update({ terms: { ...draft.terms, [taxonomy]: current.filter((item) => item !== ref) } });
    };

    const refLabel = (taxonomy: string, ref: string): string => {
        if (ref.startsWith("name:")) {
            return `${ref.slice("name:".length)}（新）`;
        }
        const found = termOptions(taxonomy).find((option) => option.id === Number(ref));
        return found ? found.name : `#${ref}`;
    };

    const badges = [
        row.postId === null ? "未推送新行" : `线上 #${row.postId}`,
        row.dirty ? "待推送" : "已同步",
        row.conflict ? "冲突：线上比快照新" : null,
        row.missing ? "线上缺失" : null,
    ].filter(Boolean) as string[];

    return (
        <div className="p-3 flex flex-col gap-3">
            <div className="flex flex-wrap gap-1">
                {badges.map((badge) => (
                    <span key={badge} className="px-1.5 rounded text-[11px] bg-neutral-100 text-neutral-600">
                        {badge}
                    </span>
                ))}
            </div>

            <label className="block">
                <span className="lbl">标题</span>
                <input className="w-full" value={draft.title} onChange={(event) => update({ title: event.target.value })} />
            </label>

            <div className="grid grid-cols-2 gap-2">
                <label className="block">
                    <span className="lbl">状态</span>
                    <select className="w-full" value={draft.status} onChange={(event) => update({ status: event.target.value })}>
                        <option value="publish">publish</option>
                        <option value="draft">draft</option>
                    </select>
                </label>
                <label className="block">
                    <span className="lbl">作者</span>
                    <select
                        className="w-full"
                        value={draft.authorId ?? ""}
                        onChange={(event) => update({ authorId: event.target.value === "" ? null : Number(event.target.value) })}
                    >
                        <option value="">（站点当前账号）</option>
                        {state.authors.map((author) => (
                            <option key={author.id} value={author.id}>
                                {author.name}（#{author.id}）
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            <label className="block">
                <span className="lbl">发布时间（站点时区；留空 = 推送时定为当前）</span>
                <input
                    type="datetime-local"
                    className="w-full"
                    value={draft.dateLocal}
                    onChange={(event) => update({ dateLocal: event.target.value })}
                />
            </label>

            {TAXONOMY_ORDER.map((taxonomy) => {
                const options = termOptions(taxonomy);
                if (taxonomy !== "resource_category" && options.length === 0 && !(draft.terms[taxonomy] ?? []).length) {
                    return null;
                }
                return (
                    <div key={taxonomy}>
                        <span className="lbl">{TAXONOMY_LABELS[taxonomy] ?? taxonomy}</span>
                        <div className="flex flex-wrap gap-1 mb-1">
                            {(draft.terms[taxonomy] ?? []).map((ref) => (
                                <span key={ref} className="chip">
                                    {refLabel(taxonomy, ref)}
                                    <button
                                        className="ml-1 text-neutral-400 hover:text-red-500"
                                        onClick={() => removeTerm(taxonomy, ref)}
                                    >
                                        ×
                                    </button>
                                </span>
                            ))}
                        </div>
                        <input
                            list={`terms-${taxonomy}`}
                            className="w-full"
                            placeholder="输入名称回车添加（存在的用词库项，不存在的新建）"
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    addTerm(taxonomy, event.currentTarget.value);
                                    event.currentTarget.value = "";
                                }
                            }}
                        />
                        <datalist id={`terms-${taxonomy}`}>
                            {options.map((option) => (
                                <option key={option.id} value={option.name} />
                            ))}
                        </datalist>
                    </div>
                );
            })}

            <label className="block">
                <span className="lbl">正文（源码，渲染归站点）</span>
                <textarea
                    className="w-full font-mono text-xs leading-5"
                    rows={8}
                    value={draft.content}
                    onChange={(event) => update({ content: event.target.value })}
                />
            </label>

            <div>
                <span className="lbl">文件列表（aiya_core_fileserve）</span>
                <FileServeEditor
                    config={draft.fileserve}
                    onChange={(config) => update({ fileserve: config })}
                />
            </div>

            <div className="border-t border-neutral-200 pt-2 flex flex-wrap gap-2">
                <button className="btn btn-primary" disabled={busy || !row.dirty} onClick={onPushRow}>
                    推送此行
                </button>
                <button className="btn" disabled={busy} onClick={onRevert}>
                    还原到快照
                </button>
                <button className="btn text-red-600" disabled={busy} onClick={onDelete}>
                    删除本地行
                </button>
            </div>

            <div className="text-xs text-neutral-400 space-y-0.5">
                {row.lastError && <div className="text-red-500">上次错误：{row.lastError}</div>}
                <div>上次同步：{row.lastSyncedGmt ?? "—"}</div>
                <div>上次推送：{row.lastPushedGmt ?? "—"}</div>
                <div>线上修改：{row.modifiedGmt || "—"}</div>
            </div>
        </div>
    );
}
