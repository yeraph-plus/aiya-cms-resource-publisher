import { useEffect, useMemo, useRef, useState } from "react";
import type { RowDTO, StateDTO } from "../types";
import { TAXONOMY_LABELS, TAXONOMY_ORDER } from "../types";
import { ensureStagingDir, fetchStagingDir, openStagingDir, saveRow, uploadImage, type RowPatch } from "../api";
import { groupTermsByRoot, mergeTermTokens, splitTermInput, termPath, type TermOption } from "../../shared/terms";
import FileServeEditor from "./FileServeEditor";
import { normalizeConfig, type FileServeConfig } from "../../shared/fileserve";
import { prependImageTags, toBase64 } from "../../shared/image-upload";

interface Props {
    row: RowDTO;
    state: StateDTO;
    busy: boolean;
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

export default function Detail({ row, state, busy, onEdit, discardFlush, notify }: Props) {
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
    // The image goes to the site's pic bed through the local server; what
    // lands in the content is the returned absolute URL — the same markup
    // the site's own editor would insert, so the post never depends on
    // this tool still running.
    const [uploading, setUploading] = useState(false);
    const [dragging, setDragging] = useState(false);
    const imageInput = useRef<HTMLInputElement | null>(null);

    /**
     * The drop zone's one job: upload what was dropped/picked, then put the
     * tags at the very start of the body. Order is preserved because the
     * site's cover pipeline takes the first image of the body — this is the
     * publishing contract, not a caret position. A failed file is reported and
     * skipped; the ones that uploaded still land.
     */
    const onImagesPicked = (files: FileList | null) => {
        const picked = Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));
        if (picked.length === 0) {
            notify("err", "没有可上传的图片（只接受图片文件）。");
            return;
        }
        setUploading(true);
        void (async () => {
            const urls: string[] = [];
            const failures: string[] = [];
            for (const file of picked) {
                try {
                    const encoded = toBase64(await file.arrayBuffer());
                    const uploaded = await uploadImage(file.name, file.type, encoded);
                    urls.push(uploaded.url);
                } catch (error) {
                    failures.push(`${file.name}：${String(error)}`);
                }
            }
            if (urls.length > 0) {
                update({ content: prependImageTags(draftRef.current.content, urls) });
            }
            if (failures.length > 0) {
                notify("err", `图片上传失败：${failures.join("；")}`);
            } else {
                notify("ok", `已插入 ${urls.length} 张图片（正文最前）`);
            }
            setUploading(false);
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
    const [staging, setStaging] = useState<{ dir: string | null; name: string | null } | null>(null);
    useEffect(() => {
        if (row.postId === null) {
            setStaging(null);
            return;
        }
        let alive = true;
        void fetchStagingDir(row.localId)
            .then((result) => {
                if (alive) {
                    setStaging(result);
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
                    setStaging({ dir: result.dir, name: result.name });
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
                    setStaging({ dir: result.dir, name: result.name });
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
                // 分类 is the one hierarchical taxonomy, so it is the one that
                // reads badly as a flat list: one line per top-level category,
                // its children on the same line behind a └, the next category
                // on the next line. Everything else is flat and unchanged.
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

            <div className="block">
                <span className="lbl">正文（源码，渲染归站点）</span>
                <div
                    className={`mb-2 rounded border border-dashed px-3 py-2 text-xs cursor-pointer ${
                        dragging
                            ? "border-blue-400 bg-blue-50 text-blue-700"
                            : "border-neutral-300 text-neutral-500 hover:border-neutral-400"
                    }`}
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
                    {uploading ? "上传中…" : "拖放图片到这里（可多张，也可点击选择）—— 一律插到正文最前"}
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
                <textarea
                    className="w-full font-mono text-xs leading-5"
                    rows={8}
                    value={draft.content}
                    onChange={(event) => update({ content: event.target.value })}
                />
            </div>

            <div>
                <span className="lbl">本地目录（可选的本地暂存）</span>
                {row.postId === null ? (
                    <p className="text-xs text-neutral-400">这一行还没推送到站点；先推送发布，再建本地目录。</p>
                ) : (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                        {staging?.name ? (
                            <>
                                <span className="font-mono">{staging.name}</span>
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
    );
}
