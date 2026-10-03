import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import type { ImportApplyResultDTO, ImportPreviewDTO } from "../api";
import type { StateDTO } from "../types";
import { parseCsv } from "../../shared/csv";
import {
    BASE_IMPORT_TARGETS,
    IMPORT_MAX_ROWS,
    TAXONOMY_LABELS,
    TAXONOMY_ORDER,
    buildImportRows,
    type ImportMapping,
} from "../../shared/import";

interface Props {
    state: StateDTO;
    onClose: () => void;
    onDone: (message: { kind: "ok" | "err"; text: string }) => Promise<void>;
}

type Phase = "pick" | "map" | "result";

/**
 * A spreadsheet's bytes are not necessarily UTF-8: Excel on Windows exports
 * GBK for non-UTF-8 locales. BOM-tagged UTF-16 is detected first, then a
 * strict UTF-8 probe, then the GBK fallback — junk decodes with replacement
 * characters either way, which the preview makes obvious.
 */
async function readCsvFile(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder("utf-16le").decode(bytes);
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        return new TextDecoder("utf-16be").decode(bytes);
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return new TextDecoder("gbk").decode(bytes);
    }
}

export default function ImportPanel({ state, onClose, onDone }: Props) {
    const [phase, setPhase] = useState<Phase>("pick");
    const [pending, setPending] = useState(false);
    const [fileError, setFileError] = useState<string | null>(null);
    const [csvText, setCsvText] = useState<string | null>(null);
    const [preview, setPreview] = useState<ImportPreviewDTO | null>(null);
    const [mapping, setMapping] = useState<ImportMapping>({});
    const [defaultStatus, setDefaultStatus] = useState("draft");
    const [defaultAuthorId, setDefaultAuthorId] = useState<number | null>(state.settings.defaultAuthorId);
    const [unmatchedAuthor, setUnmatchedAuthor] = useState<"error" | "default">("error");
    const [result, setResult] = useState<ImportApplyResultDTO | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onClose();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const onFile = async (file: File | undefined) => {
        if (!file) {
            return;
        }
        setPending(true);
        setFileError(null);
        try {
            const text = await readCsvFile(file);
            const next = await api.importPreview(text);
            setCsvText(text);
            setPreview(next);
            setMapping({ ...next.guess });
            setResult(null);
            setPhase("map");
        } catch (error) {
            setFileError(String(error));
        } finally {
            setPending(false);
            if (fileInput.current) {
                fileInput.current.value = "";
            }
        }
    };

    // The exact server-side validation, run live: the preview counts are the
    // counts the apply writes.
    const summary = useMemo(() => {
        if (csvText === null) {
            return null;
        }
        return buildImportRows(parseCsv(csvText), mapping, {
            authors: state.authors,
            termOptions: state.terms,
            defaultStatus,
            defaultAuthorId,
            unmatchedAuthor,
        });
    }, [csvText, mapping, state.authors, state.terms, defaultStatus, defaultAuthorId, unmatchedAuthor]);

    const overCap = preview !== null && preview.rowCount > IMPORT_MAX_ROWS;
    const canApply =
        summary !== null && summary.fatal === null && !overCap && summary.rows.length > 0 && preview !== null && preview.rowCount > 0;

    const apply = async () => {
        if (csvText === null) {
            return;
        }
        setPending(true);
        try {
            const outcome = await api.importApply({ csv: csvText, mapping, defaultStatus, defaultAuthorId, unmatchedAuthor });
            setResult(outcome);
            setPhase("result");
            await onDone({
                kind: outcome.failed > 0 ? "err" : "ok",
                text: `导入完成：${outcome.imported} 行入队${outcome.failed > 0 ? `，${outcome.failed} 行失败` : ""}。`,
            });
        } catch (error) {
            await onDone({ kind: "err", text: `导入失败：${String(error)}` });
        } finally {
            setPending(false);
        }
    };

    const backToPick = () => {
        setPhase("pick");
        setPreview(null);
        setCsvText(null);
        setFileError(null);
    };

    const columnSelect = (key: string) => (
        <select
            value={typeof mapping[key] === "number" ? String(mapping[key]) : ""}
            onChange={(event) =>
                setMapping((current) => ({ ...current, [key]: event.target.value === "" ? null : Number(event.target.value) }))
            }
        >
            <option value="">（不导入）</option>
            {(preview?.headers ?? []).map((header, index) => (
                <option key={index} value={index}>
                    {index + 1}. {header === "" ? "（无名列）" : header}
                </option>
            ))}
        </select>
    );

    return (
        <div
            className="fixed inset-0 z-50 bg-black/40 grid place-items-center"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <div className="bg-white rounded-lg shadow-xl w-[820px] max-w-[94vw] max-h-[90vh] flex flex-col">
                <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-200">
                    <span className="font-semibold">导入 CSV → 发布队列</span>
                    <button className="text-neutral-400 hover:text-neutral-700 text-lg leading-none" onClick={onClose}>
                        ×
                    </button>
                </div>

                <div className="px-5 py-4 overflow-y-auto min-h-0">
                    {phase === "pick" && (
                        <div>
                            <button className="btn" disabled={pending} onClick={() => fileInput.current?.click()}>
                                选择 CSV 文件…
                            </button>
                            <input
                                ref={fileInput}
                                type="file"
                                accept=".csv,text/csv"
                                className="hidden"
                                onChange={(event) => void onFile(event.target.files?.[0])}
                            />
                            <p className="mt-3 text-xs text-neutral-500 leading-5">
                                第一行是表头，之后每行进一条待推送的本地新行。编码自动识别（UTF-8 / GBK / UTF-16）。
                                <br />
                                表头会按常用名字自动猜测映射（标题 / 正文 / 状态 / 发布时间 / 发布者 / 六个术语列），下一步可以改。
                            </p>
                            {pending && <p className="mt-2 text-xs text-neutral-400">读取中…</p>}
                            {fileError && <p className="mt-2 text-xs text-red-600">读取失败：{fileError}</p>}
                        </div>
                    )}

                    {phase === "map" && preview !== null && summary !== null && (
                        <div className="flex flex-col gap-4">
                            <p className="text-xs text-neutral-500">
                                共 {preview.rowCount} 行数据
                                {overCap && <span className="text-red-600">（超过上限 {IMPORT_MAX_ROWS} 行，请拆分文件）</span>}
                                ；
                                {summary.fatal ? (
                                    <span className="text-red-600"> {summary.fatal}</span>
                                ) : (
                                    <>
                                        将导入 <span className="text-green-700 font-medium">{summary.rows.length}</span> 行
                                        {summary.errors.length > 0 && (
                                            <span className="text-red-600">，{summary.errors.length} 行有问题不导入</span>
                                        )}
                                        。
                                    </>
                                )}
                            </p>

                            <fieldset className="border border-neutral-200 rounded p-3">
                                <legend className="text-xs text-neutral-500 px-1">基础字段</legend>
                                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-center">
                                    {BASE_IMPORT_TARGETS.map((target) => (
                                        <div key={target.key} className="contents">
                                            <label className="text-right text-neutral-500">{target.label}</label>
                                            {columnSelect(target.key)}
                                        </div>
                                    ))}
                                    <label className="text-right text-neutral-500">默认状态</label>
                                    <select value={defaultStatus} onChange={(event) => setDefaultStatus(event.target.value)}>
                                        <option value="draft">draft（草稿）</option>
                                        <option value="publish">publish（发布）</option>
                                        <option value="future">future（定时）</option>
                                    </select>
                                    <label className="text-right text-neutral-500">默认发布者</label>
                                    <select
                                        value={defaultAuthorId ?? ""}
                                        onChange={(event) =>
                                            setDefaultAuthorId(event.target.value === "" ? null : Number(event.target.value))
                                        }
                                    >
                                        <option value="">（推送后由站点定为当前账号）</option>
                                        {state.authors.map((author) => (
                                            <option key={author.id} value={author.id}>
                                                {author.name}（#{author.id}）
                                            </option>
                                        ))}
                                    </select>
                                    <label className="text-right text-neutral-500">未匹配作者</label>
                                    <div className="flex items-center gap-3 text-sm">
                                        <label className="flex items-center gap-1">
                                            <input
                                                type="radio"
                                                checked={unmatchedAuthor === "error"}
                                                onChange={() => setUnmatchedAuthor("error")}
                                            />
                                            该行报错
                                        </label>
                                        <label className="flex items-center gap-1">
                                            <input
                                                type="radio"
                                                checked={unmatchedAuthor === "default"}
                                                onChange={() => setUnmatchedAuthor("default")}
                                            />
                                            用默认发布者
                                        </label>
                                    </div>
                                </div>
                            </fieldset>

                            <fieldset className="border border-neutral-200 rounded p-3">
                                <legend className="text-xs text-neutral-500 px-1">术语列（顿号/逗号分隔，站内没有的词推送时自动创建）</legend>
                                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-center">
                                    {TAXONOMY_ORDER.map((taxonomy) => (
                                        <div key={taxonomy} className="contents">
                                            <label className="text-right text-neutral-500">{TAXONOMY_LABELS[taxonomy]}（标签）</label>
                                            {columnSelect(`term:${taxonomy}`)}
                                        </div>
                                    ))}
                                </div>
                            </fieldset>

                            {summary.errors.length > 0 && (
                                <div className="border border-red-200 bg-red-50 rounded p-3 text-xs text-red-700">
                                    <p className="mb-1 font-medium">不导入的行（前 {Math.min(8, summary.errors.length)} 条）：</p>
                                    <ul className="list-disc list-inside space-y-0.5">
                                        {summary.errors.slice(0, 8).map((error) => (
                                            <li key={error.row}>
                                                第 {error.row} 行（{error.title}）：{error.error}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            <div>
                                <p className="lbl">文件预览（前 {preview.preview.length} 行）</p>
                                <div className="overflow-x-auto border border-neutral-200 rounded">
                                    <table className="text-xs">
                                        <thead>
                                            <tr className="bg-neutral-50">
                                                {preview.headers.map((header, index) => (
                                                    <th key={index} className="px-2 py-1 border-b border-neutral-200 text-left whitespace-nowrap">
                                                        {header === "" ? "（无名列）" : header}
                                                    </th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {preview.preview.map((cells, rowIndex) => (
                                                <tr key={rowIndex} className="border-b border-neutral-100 last:border-b-0">
                                                    {preview.headers.map((_, index) => (
                                                        <td key={index} className="px-2 py-1 max-w-64 truncate">
                                                            {cells[index] ?? ""}
                                                        </td>
                                                    ))}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    )}

                    {phase === "result" && result !== null && (
                        <div className="flex flex-col gap-3 text-sm">
                            <p>
                                导入完成：<span className="text-green-700 font-medium">{result.imported}</span> 行已进待推送队列，
                                {result.failed} 行失败。
                            </p>
                            {result.errors.length > 0 && (
                                <div className="border border-red-200 bg-red-50 rounded p-3 text-xs text-red-700 max-h-64 overflow-y-auto">
                                    <ul className="list-disc list-inside space-y-0.5">
                                        {result.errors.map((error) => (
                                            <li key={error.row}>
                                                第 {error.row} 行（{error.title}）：{error.error}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            <p className="text-xs text-neutral-500">失败行不占用队列；修好 CSV 后重新导入即可。新行可用「未推送新行」过滤查看。</p>
                        </div>
                    )}
                </div>

                <div className="px-5 py-3 border-t border-neutral-200 flex items-center gap-2">
                    {phase === "map" && (
                        <>
                            <button className="btn" disabled={pending} onClick={backToPick}>
                                重新选文件
                            </button>
                            <button className="btn btn-primary" disabled={pending || !canApply} onClick={() => void apply()}>
                                导入 {summary?.rows.length ?? 0} 行
                            </button>
                        </>
                    )}
                    {phase === "result" && (
                        <button className="btn btn-primary" onClick={onClose}>
                            完成
                        </button>
                    )}
                    <span className="text-xs text-neutral-400">导入只建本地行，不推送；确认无误后用「推送」写站点。</span>
                </div>
            </div>
        </div>
    );
}
