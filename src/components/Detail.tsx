import { useEffect, useMemo, useRef, useState } from "react";
import type { ContentMode, DetailTab, RowDTO, StateDTO } from "../types";
import { TAXONOMY_LABELS, TAXONOMY_ORDER } from "../types";
import { ensureStagingDir, fetchStagingDir, openStagingDir, saveRow, stageImage, type RowPatch } from "../api";
import { groupTermsByRoot, mergeTermTokens, splitTermInput, termPath, type TermOption } from "../../shared/terms";
import FileServeEditor from "./FileServeEditor";
import HtmlEditor from "./HtmlEditor";
import HtmlPreview from "./HtmlPreview";
import { normalizeConfig, type FileServeConfig } from "../../shared/fileserve";
import { prependImageTags, toBase64 } from "../../shared/image-upload";

interface Props {
    row: RowDTO;
    state: StateDTO;
    busy: boolean;
    /** The open tab / view live in the App: switching rows keeps them. */
    tab: DetailTab;
    onTab: (tab: DetailTab) => void;
    mode: ContentMode;
    onMode: (mode: ContentMode) => void;
    /** Hands the row the server stored back to the App for a one-row update. */
    onEdit: (row: RowDTO) => void;
    /** localIds whose pending edit must be dropped rather than flushed — the
     * App adds one before 还原/删除, which discard the panel's draft. */
    discardFlush: { current: Set<number> };
    notify: (kind: "ok" | "err", text: string) => void;
}

/** '2020-05-06T07:08:00' → datetime-local value; '' stays empty. */
function toInput(value: string): string {
    return value === "" ? "" : value.slice(0, 16);
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

const TABS: { id: DetailTab; label: string }[] = [
    { id: "body", label: "正文" },
    { id: "props", label: "属性" },
];

export default function Detail({ row, state, busy, tab, onTab, mode, onMode, onEdit, discardFlush, notify }: Props) {
    const draftFromRow = (source: RowDTO): Draft => ({
        status: source.status,
        title: source.title,
        content: source.content,
        authorId: source.authorId,
        dateLocal: toInput(source.dateLocal),
        terms: source.terms,
        fileserve: (source.fileserveParsed ?? null) as FileServeConfig | null,
    });
    const [draft, setDraft] = useState<Draft>(() => draftFromRow(row));
    const draftRef = useRef(draft);
    // In-flight saves, counted rather than flagged: two persisted drafts can
    // overlap (an edit arriving while the previous save is still on the wire),
    // and a boolean would report "nothing in flight" as soon as the first one
    // settled, letting the server's older copy overwrite the newer draft.
    const saving = useRef(0);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // The stored file list this draft was built from. The netdisk lane fills
    // links behind the panel's back, and the server merges the draft against
    // this base so a stale draft cannot resurrect an empty link. Read at save
    // time and carried with the draft, so a save already in the debounce keeps
    // its own base even if the panel rebases in the meantime.
    const fileserveBase = useRef<string | null>(row.fileserve);

    // Writes the draft to the local store. Called by the debounce below and
    // once more from the unmount flush — switching rows must not discard an
    // edit that has not had its 600ms yet. The saved row goes back to the App,
    // which replaces that one row: the list is never refetched for a panel
    // edit, so the panel is not handed its own edit back mid-typing.
    const persist = async (next: Draft, base: string | null): Promise<void> => {
        saving.current += 1;
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
                fileserveBase: base,
            };
            const saved = await saveRow(row.localId, payload);
            if (saved.fileserveMoved) {
                // A netdisk fill won for at least one group. Take the stored
                // file list so this panel stops disagreeing with it — keeping
                // the draft would make the next save fight the merge again.
                const rebased: Draft = {
                    ...draftRef.current,
                    fileserve: (saved.row.fileserveParsed ?? null) as FileServeConfig | null,
                };
                draftRef.current = rebased;
                setDraft(rebased);
                notify("ok", "文件列表已被网盘脚本回填，草稿没有覆盖它；你的其他修改已保存。");
            }
            fileserveBase.current = saved.row.fileserve;
            onEdit(saved.row);
        } catch (error) {
            notify("err", `保存失败：${String(error)}`);
        } finally {
            saving.current -= 1;
        }
    };

    useEffect(() => {
        return () => {
            if (timer.current === null) {
                return;
            }
            clearTimeout(timer.current);
            timer.current = null;
            // 还原/删除 are replaces, not switches: flushing here would write
            // the discarded draft straight back over the result (the revert
            // undone, the deleted row rewritten).
            if (discardFlush.current.delete(row.localId)) {
                return;
            }
            void persist(draftRef.current, fileserveBase.current);
        };
        // row is constant for this instance (the App keys Detail by row), so
        // the first-render closure is the right one to flush with.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Adopt the server's version of the row only when nothing local is
    // outstanding: a grid-cell edit on this same row has to land in the panel,
    // but a draft that is still inside its debounce window — or in flight —
    // must not be overwritten by the round-trip carrying the older text.
    // `timer` is cleared to null the moment it fires, so a finished save never
    // holds this guard shut.
    useEffect(() => {
        if (saving.current > 0 || timer.current !== null) {
            return;
        }
        const next = draftFromRow(row);
        draftRef.current = next;
        fileserveBase.current = row.fileserve;
        setDraft(next);
    }, [row]);

    const save = (next: Draft) => {
        if (timer.current) {
            clearTimeout(timer.current);
        }
        const base = fileserveBase.current;
        timer.current = setTimeout(() => {
            timer.current = null;
            void persist(next, base);
        }, 600);
    };

    const update = (patch: Partial<Draft>) => {
        const next = { ...draftRef.current, ...patch };
        draftRef.current = next;
        setDraft(next);
        save(next);
    };

    // --- 正文插图 ---------------------------------------------------------
    // Picking an image no longer touches the network: the bytes are copied
    // into the app's own images directory and the source keeps the real
    // absolute path. `runPush` uploads the file and rewrites the reference
    // just before the row is written, so an unpublished row never occupies
    // the pic bed and a failed push leaves no half-inserted body behind.
    const [staging, setStaging] = useState(false);
    const [dragging, setDragging] = useState(false);
    const imageInput = useRef<HTMLInputElement | null>(null);

    /**
     * The drop zone's one job: stage what was dropped/picked, then put the
     * tags at the very start of the body. Order is preserved because the
     * site's cover pipeline takes the first image of the body — this is the
     * publishing contract, not a caret position. A failed file is reported and
     * skipped; the ones that staged still land.
     */
    const onImagesPicked = (files: FileList | null) => {
        const picked = Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));
        if (picked.length === 0) {
            notify("err", "没有可插入的图片（只接受图片文件）。");
            return;
        }
        setStaging(true);
        void (async () => {
            const srcs: string[] = [];
            const failures: string[] = [];
            for (const file of picked) {
                try {
                    const staged = await stageImage(file.name, file.type, toBase64(await file.arrayBuffer()));
                    srcs.push(staged.src);
                } catch (error) {
                    failures.push(`${file.name}：${String(error)}`);
                }
            }
            if (srcs.length > 0) {
                update({ content: prependImageTags(draftRef.current.content, srcs) });
            }
            if (failures.length > 0) {
                notify("err", `图片暂存失败：${failures.join("；")}`);
            } else {
                notify("ok", `已插入 ${srcs.length} 张图片（存本地，推送时上传）`);
            }
            setStaging(false);
        })();
    };

    const termOptions = useMemo(
        () => (taxonomy: string) => state.terms[taxonomy] ?? [],
        [state.terms],
    );

    const addRef = (taxonomy: string, ref: string) => {
        const current = draftRef.current.terms[taxonomy] ?? [];
        if (current.includes(ref)) {
            return;
        }
        update({ terms: { ...draftRef.current.terms, [taxonomy]: [...current, ref] } });
    };

    // Raw per-taxonomy input text; committed on Enter/blur.
    const [termInputs, setTermInputs] = useState<Record<string, string>>({});

    /** Commits the "、" separated input into the selection, merged and deduped. */
    const commitTermInput = (taxonomy: string): void => {
        const raw = termInputs[taxonomy] ?? "";
        setTermInputs((prev) => ({ ...prev, [taxonomy]: "" }));
        const tokens = splitTermInput(raw);
        if (tokens.length === 0) {
            return;
        }
        const current = draftRef.current.terms;
        update({
            terms: { ...current, [taxonomy]: mergeTermTokens(current[taxonomy] ?? [], tokens, termOptions(taxonomy)) },
        });
    };

    const removeTerm = (taxonomy: string, ref: string) => {
        const current = draftRef.current.terms[taxonomy] ?? [];
        update({ terms: { ...draftRef.current.terms, [taxonomy]: current.filter((item) => item !== ref) } });
    };

    const refLabel = (taxonomy: string, ref: string): string => {
        if (ref.startsWith("name:")) {
            return `${ref.slice("name:".length)}（新）`;
        }
        const found = termOptions(taxonomy).find((option) => option.id === Number(ref));
        return found ? found.name : `#${ref}`;
    };

    // --- 本地目录（纯本地辅助）-----------------------------------------------
    // Staging folder for files pending the client upload; purely local — the
    // netdisk lane names and creates its folder netdisk-side and never reads
    // this. Keyed by the site's post id; adding the first group triggers it.
    const [localDir, setLocalDir] = useState<{ dir: string | null; name: string | null } | null>(null);
    useEffect(() => {
        if (row.postId === null) {
            setLocalDir(null);
            return;
        }
        let alive = true;
        void fetchStagingDir(row.localId)
            .then((result) => {
                if (alive) {
                    setLocalDir(result);
                }
            })
            .catch(() => {});
        return () => {
            alive = false;
        };
    }, [row.localId, row.postId]);

    const triggerStaging = () => {
        if (row.postId === null) {
            return;
        }
        void ensureStagingDir(row.localId)
            .then((result) => {
                if (result.dir !== null) {
                    setLocalDir({ dir: result.dir, name: result.name });
                    if (result.status === "created" || result.status === "claimed") {
                        notify("ok", `本地目录已就绪：${result.name}`);
                    }
                }
            })
            .catch(() => {
                // Blocked states are logged server-side; nothing to say here.
            });
    };

    const onOpenDir = () => {
        void (async () => {
            try {
                const result = await openStagingDir(row.localId);
                if (result.dir !== null) {
                    setLocalDir({ dir: result.dir, name: result.name });
                }
            } catch (error) {
                notify("err", String(error));
            }
        })();
    };

    const badges = [
        row.postId === null ? "未推送新行" : `线上 #${row.postId}`,
        row.dirty ? "待推送" : "已同步",
        row.conflict ? "冲突：线上比快照新" : null,
        row.missing ? "线上缺失" : null,
    ].filter(Boolean) as string[];

    return (
        <div className="h-full flex flex-col min-h-0">
            {/* Tab strip; the badges sit here rather than in a pane, so they
                stay readable whichever tab is open. */}
            <div className="flex items-end gap-1 px-3 pt-1.5 border-b border-neutral-200 shrink-0">
                {TABS.map((entry) => (
                    <button
                        key={entry.id}
                        className={`px-2.5 py-1 text-xs border-b-2 -mb-px ${
                            tab === entry.id
                                ? "border-blue-600 text-blue-700 font-medium"
                                : "border-transparent text-neutral-500 hover:text-neutral-700"
                        }`}
                        onClick={() => onTab(entry.id)}
                    >
                        {entry.label}
                        {entry.id === "body" && draft.content.trim() === "" ? <span className="ml-1 text-neutral-400">·空</span> : null}
                    </button>
                ))}
                <span className="ml-auto flex flex-wrap gap-1 justify-end pb-1">
                    {badges.map((badge) => (
                        <span key={badge} className="px-1.5 rounded text-[11px] bg-neutral-100 text-neutral-600">
                            {badge}
                        </span>
                    ))}
                </span>
            </div>

            {/* ---- 正文 ------------------------------------------------------ */}
            {/* Kept mounted while 属性 is open: the editor holds the undo stack
                and the caret, and the preview holds its scroll position. */}
            <div className={`flex-1 min-h-0 flex flex-col gap-2 p-3 ${tab === "body" ? "" : "hidden"}`}>
                <label className="block shrink-0">
                    <span className="lbl">标题</span>
                    <input className="w-full" value={draft.title} onChange={(event) => update({ title: event.target.value })} />
                </label>

                <div className="flex items-center gap-2 shrink-0">
                    <div className="flex rounded border border-neutral-300 overflow-hidden text-xs shrink-0">
                        {([
                            { id: "edit", label: "编辑" },
                            { id: "preview", label: "预览" },
                        ] as const).map((entry) => (
                            <button
                                key={entry.id}
                                className={`px-2.5 py-1 ${
                                    mode === entry.id ? "bg-blue-600 text-white" : "bg-white text-neutral-600 hover:bg-neutral-50"
                                }`}
                                onClick={() => onMode(entry.id)}
                            >
                                {entry.label}
                            </button>
                        ))}
                    </div>
                    <div
                        className={`flex-1 min-w-0 rounded border border-dashed px-2 py-1 text-xs cursor-pointer truncate ${
                            dragging
                                ? "border-blue-400 bg-blue-50 text-blue-700"
                                : "border-neutral-300 text-neutral-500 hover:border-neutral-400"
                        }`}
                        title="拖放或点击选择图片；插入正文最前，先存本地，推送时上传"
                        onClick={() => imageInput.current?.click()}
                        onDragOver={(event) => {
                            event.preventDefault();
                            setDragging(true);
                        }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={(event) => {
                            event.preventDefault();
                            setDragging(false);
                            onImagesPicked(event.dataTransfer.files);
                        }}
                    >
                        {staging ? "暂存中…" : "+ 图片（插到正文最前）"}
                    </div>
                    <input
                        ref={imageInput}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(event) => {
                            const files = event.currentTarget.files;
                            event.currentTarget.value = "";
                            onImagesPicked(files);
                        }}
                    />
                </div>

                <div className="flex-1 min-h-0">
                    <div className={`h-full border border-neutral-200 rounded overflow-hidden ${mode === "edit" ? "" : "hidden"}`}>
                        <HtmlEditor value={draft.content} onChange={(content) => update({ content })} visible={mode === "edit"} />
                    </div>
                    <div className={`h-full ${mode === "preview" ? "" : "hidden"}`}>
                        {/* 预览 opens by default, and an empty body renders to a
                            blank page — a new row would look broken. Say what is
                            missing and hand over the one action that fixes it. */}
                        {draft.content.trim() === "" ? (
                            <div className="h-full grid place-items-center rounded border border-dashed border-neutral-200 px-6 text-center">
                                <div className="space-y-2">
                                    <p className="text-sm text-neutral-500">正文还是空的</p>
                                    <button className="btn" onClick={() => onMode("edit")}>
                                        开始写正文
                                    </button>
                                    <p className="text-[11px] text-neutral-400">
                                        也可以把图片拖到上面的虚线区，先插图再写。
                                    </p>
                                </div>
                            </div>
                        ) : (
                            <HtmlPreview content={draft.content} siteUrl={state.settings.siteUrl} />
                        )}
                    </div>
                </div>

                <p className="text-[11px] text-neutral-400 shrink-0">
                    源码即站点收到的内容；<code>file://</code> 图片先存本地，推送这一行时上传并换成站点地址。
                </p>
            </div>

            {/* ---- 属性 ------------------------------------------------------ */}
            <div className={`flex-1 min-h-0 overflow-y-auto p-3 ${tab === "props" ? "" : "hidden"}`}>
                <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-2">
                        <label className="block">
                            <span className="lbl">状态</span>
                            <select className="w-full" value={draft.status} onChange={(event) => update({ status: event.target.value })}>
                                <option value="publish">publish</option>
                                <option value="draft">draft</option>
                                <option value="future">future（站点按日期定时）</option>
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
                        const selected = draft.terms[taxonomy] ?? [];
                        if (taxonomy !== "resource_category" && options.length === 0 && selected.length === 0) {
                            return null;
                        }
                        // 分类 is the one hierarchical taxonomy, so it is the one
                        // that reads badly as a flat list: one line per top-level
                        // category, its children on the same line behind a └, the
                        // next category on the next line. Everything else is flat.
                        const hierarchical = options.some((option) => option.parent !== 0);
                        const renderOption = (option: TermOption, child = false) => {
                            const ref = String(option.id);
                            return (
                                <label
                                    key={ref}
                                    className="inline-flex items-center gap-1 cursor-pointer"
                                    title={termPath(option, options)}
                                >
                                    {child ? <span className="text-neutral-300">└</span> : null}
                                    <input
                                        type="checkbox"
                                        checked={selected.includes(ref)}
                                        onChange={(event) => {
                                            if (event.target.checked) {
                                                addRef(taxonomy, ref);
                                            } else {
                                                removeTerm(taxonomy, ref);
                                            }
                                        }}
                                    />
                                    <span className={child ? "text-neutral-600" : "font-medium"}>{option.name}</span>
                                </label>
                            );
                        };
                        return (
                            <div key={taxonomy}>
                                <span className="lbl">{TAXONOMY_LABELS[taxonomy] ?? taxonomy}</span>
                                <input
                                    className="w-full mb-1"
                                    placeholder="名称用「、」分隔可一次添加多个，回车确认"
                                    value={termInputs[taxonomy] ?? ""}
                                    onChange={(event) => setTermInputs((prev) => ({ ...prev, [taxonomy]: event.target.value }))}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter") {
                                            event.preventDefault();
                                            commitTermInput(taxonomy);
                                        }
                                    }}
                                    onBlur={() => commitTermInput(taxonomy)}
                                />
                                {hierarchical ? (
                                    <div className="flex flex-col gap-y-1">
                                        {groupTermsByRoot(options).map((group) => (
                                            <div key={group.root.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                                {renderOption(group.root)}
                                                {group.children.map((child) => renderOption(child, true))}
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                                        {options.map((option) => renderOption(option))}
                                    </div>
                                )}
                                {/* Selected refs missing from the term registry stay
                                    visible and removable: not-yet-created names. */}
                                {selected
                                    .filter((ref) => ref.startsWith("name:") || !options.some((option) => String(option.id) === ref))
                                    .map((ref) => (
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
                        );
                    })}

                    <div>
                        <span className="lbl">本地目录（可选的本地暂存）</span>
                        {row.postId === null ? (
                            <p className="text-xs text-neutral-400">这一行还没推送到站点；先推送发布，再建本地目录。</p>
                        ) : (
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                                {localDir?.name ? (
                                    <>
                                        <span className="font-mono">{localDir.name}</span>
                                        <button className="btn" disabled={busy} onClick={onOpenDir}>
                                            打开目录
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        <span className="text-neutral-400">尚未创建</span>
                                        <button className="btn" disabled={busy} onClick={onOpenDir}>
                                            创建目录
                                        </button>
                                    </>
                                )}
                                <span className="text-neutral-400">纯本地暂存辅助，网盘回填不依赖它；目录会在下方添加数据组时自动创建。</span>
                            </div>
                        )}
                    </div>

                    <div>
                        <span className="lbl">文件列表（aiya_core_fileserve）</span>
                        <FileServeEditor
                            config={draft.fileserve}
                            onChange={(config) => update({ fileserve: config })}
                            onGroupAdded={triggerStaging}
                        />
                    </div>

                    <div className="text-xs text-neutral-400 space-y-0.5">
                        {row.lastError && <div className="text-red-500">上次错误：{row.lastError}</div>}
                        <div>上次同步：{row.lastSyncedGmt ?? "—"}</div>
                        <div>上次推送：{row.lastPushedGmt ?? "—"}</div>
                        <div>线上修改：{row.modifiedGmt || "—"}</div>
                    </div>
                </div>
            </div>
        </div>
    );
}
