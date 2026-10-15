import { useCallback, useEffect, useMemo, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import {
    AllCommunityModule,
    ModuleRegistry,
    type CellValueChangedEvent,
    type ColDef,
    type ColumnMovedEvent,
    type ColumnResizedEvent,
    type ColumnState,
    type GridApi,
    type GridReadyEvent,
    type SortChangedEvent,
} from "ag-grid-community";
import type { AuthorDTO, RowDTO, TermInfo } from "../types";
import { TAXONOMY_ORDER } from "../types";
import { configSummary } from "../../shared/fileserve";
import { termPath } from "../../shared/terms";
import type { RowPatch } from "../api";

ModuleRegistry.registerModules([AllCommunityModule]);

/**
 * v2 because v1 was written while the fieldless columns still had AG Grid's
 * auto-generated ids ("0".."9"). Those ids were positional and shifted on
 * every columnDefs rebuild, so the saved v1 arrangement pointed at whichever
 * column happened to inherit the number — restoring it scrambled the order
 * (the "标记 column jumps next to 发布时间" report). Every column now carries
 * an explicit colId, and v1's poisoned entries are simply not read.
 */
const COLUMN_STATE_KEY = "publisher.gridColumnState.v2";

/** Widths/order/sort as the user last arranged them, or null. */
function loadColumnState(): ColumnState[] | null {
    try {
        const parsed = JSON.parse(window.localStorage.getItem(COLUMN_STATE_KEY) ?? "null");
        return Array.isArray(parsed) ? (parsed as ColumnState[]) : null;
    } catch {
        return null;
    }
}

function persistColumnState(api: GridApi<RowDTO>): void {
    window.localStorage.setItem(COLUMN_STATE_KEY, JSON.stringify(api.getColumnState()));
}

/**
 * Only column events the user caused (sources "uiColumn*") may overwrite the
 * saved arrangement. AG Grid also fires resize/sort events with sources like
 * "gridInitializing", "api" and "setColumnState" — persisting those would
 * clobber the saved widths with the not-yet-restored defaults at every
 * startup, which looked exactly like "widths reset on the first click".
 */
function isUserColumnEvent(source: unknown): boolean {
    return typeof source === "string" && source.startsWith("ui");
}

/** Module-level so AgGridReact never sees a new defaultColDef identity per render. */
const DEFAULT_COL_DEF: ColDef<RowDTO> = { resizable: true, sortable: true };

/** Apply the saved state. Columns are fixed-width (no flex), so a stale flex
 * value in old saved states must be dropped — a surviving flex lets a layout
 * pass override user widths.
 *
 * The state handed to applyColumnState is rebuilt to cover *every* current
 * column: the saved entries first, in their saved order, then any column the
 * saved state predates (a colId added by a later release) appended in defs
 * order. A partial state would leave the unnamed columns to AG Grid's own
 * placement, which is what moved them around. */
function applySavedColumnState(api: GridApi<RowDTO>): void {
    const saved = loadColumnState();
    if (!saved) {
        return;
    }
    const live = (api.getColumns() ?? []).map((column) => column.getColId());
    const liveIds = new Set(live);
    const savedIds = new Set(saved.map((entry) => entry.colId));
    const state: ColumnState[] = [
        ...saved.filter((entry) => liveIds.has(entry.colId)).map((entry) => ({ ...entry, flex: null })),
        ...live.filter((colId) => !savedIds.has(colId)).map((colId) => ({ colId })),
    ];
    if (state.length > 0) {
        api.applyColumnState({ state, applyOrder: true });
    }
}

interface Props {
    rows: RowDTO[];
    terms: Record<string, TermInfo[]>;
    authors: AuthorDTO[];
    selectedId: number | null;
    /** A row the caller just created: scrolled into view once it exists. */
    scrollToId: number | null;
    onSelect: (localId: number) => void;
    onEdit: (localId: number, patch: RowPatch) => void;
}

function flagBadges(row: RowDTO): string[] {
    const badges: string[] = [];
    if (row.postId === null) {
        badges.push("新行");
    }
    if (row.dirty) {
        badges.push("待推送");
    }
    if (row.conflict) {
        badges.push("冲突");
    }
    if (row.missing) {
        badges.push("线上缺失");
    }
    if (row.lastError) {
        badges.push("错误");
    }
    const fs = row.fileServe;
    if (fs.status === "unmounted" && row.postId !== null) {
        badges.push("无文件挂载");
    }
    if (fs.status === "fillable") {
        const labels = [...new Set(fs.items.map((item) => item.label))].join("、");
        badges.push(`可补：${labels}`);
    }
    return badges;
}

function refsToNames(refs: string[] | undefined, options: TermInfo[] | undefined): string {
    if (!refs || refs.length === 0) {
        return "";
    }
    return refs
        .map((ref) => {
            if (ref.startsWith("name:")) {
                return `${ref.slice("name:".length)}（新）`;
            }
            const found = options?.find((option) => option.id === Number(ref));
            // Full path, so two same-named children of different parents do not
            // read as the same value; a flat taxonomy's path is just its name.
            return found ? termPath(found, options ?? []) : `#${ref}`;
        })
        .join("、");
}

function authorLabel(authors: AuthorDTO[], id: number | null): string {
    if (id === null) {
        return "";
    }
    return authors.find((author) => author.id === id)?.name ?? `#${id}`;
}

export default function Grid({ rows, terms, authors, selectedId, scrollToId, onSelect, onEdit }: Props) {
    // The valueGetters resolve the term registry and the author list through
    // refs so columnDefs is built exactly once. `terms` and `authors` are
    // fresh objects on every /api/state, and a rebuilt columnDefs array makes
    // AG Grid recreate its columns and fall back to the defaults — so the grid
    // used to rebuild its columns on every pull, settings save and import, and
    // then re-apply the saved arrangement over whatever the user had just
    // done. The effect further down swaps the refs in and re-renders the cells
    // that read them.
    const termsRef = useRef(terms);
    const authorsRef = useRef(authors);

    const columnDefs = useMemo<ColDef<RowDTO>[]>(() => {
        const tagTaxonomies = TAXONOMY_ORDER.filter((slug) => slug !== "resource_category");
        // Every column carries an explicit colId. Without one, AG Grid invents
        // an id for each column that has no `field` (标记/作者/分类/标签/文件列表
        // here) and, because a rebuilt columnDefs array never matches the old
        // def by reference, it mints fresh ids on every rebuild — "0","1","2"…
        // then "5"…, "10"… The persisted column state then names columns that
        // no longer mean the same thing, and restoring it shuffles the order.
        // A colId also lets AG Grid reuse the existing column instead of
        // destroying and recreating it on each rebuild.
        return [
            {
                // The error text itself rides on the badge's native tooltip —
                // the wide error column it replaced is gone.
                colId: "flag",
                headerName: "标记",
                width: 170,
                valueGetter: (params) => flagBadges(params.data!).join(" "),
                cellRenderer: (params: { data?: RowDTO }) => {
                    const data = params.data;
                    if (!data) {
                        return "";
                    }
                    return (
                        <span className="flex gap-1">
                            {flagBadges(data).map((badge) => (
                                <span
                                    key={badge}
                                    title={
                                        badge === "错误"
                                            ? (data.lastError ?? undefined)
                                            : badge === "无文件挂载"
                                              ? "这一行还没有文件列表；在详情面板添加网盘数据组"
                                              : badge.startsWith("可补")
                                                ? data.fileServe.items.map((item) => `组 #${item.groupId} · ${item.label}`).join("；")
                                                : undefined
                                    }
                                    className={`px-1 rounded text-[11px] ${
                                        badge === "错误"
                                            ? "bg-red-600 text-white"
                                            : badge.startsWith("可补")
                                              ? "bg-cyan-100 text-cyan-700"
                                              : badge === "无文件挂载"
                                                ? "bg-neutral-200 text-neutral-600"
                                                : badge === "冲突"
                                                  ? "bg-red-100 text-red-700"
                                                  : badge === "待推送"
                                                    ? "bg-amber-100 text-amber-700"
                                                    : badge === "线上缺失"
                                                      ? "bg-neutral-300 text-neutral-700"
                                                      : "bg-blue-100 text-blue-700"
                                    }`}
                                >
                                    {badge}
                                </span>
                            ))}
                        </span>
                    );
                },
            },
            {
                // A row stays "new" until its first push assigns a post id.
                // AG Grid's default comparator sorts a missing value *first*
                // in ascending order, so an un-pushed row jumped to the top of
                // an ID-sorted list. Rank it as the largest id instead: last
                // ascending, first descending — i.e. it follows the sort as the
                // newest row, exactly where the natural order already puts it.
                // Nothing is written: the cell still shows blank.
                colId: "postId",
                headerName: "ID",
                field: "postId",
                width: 70,
                comparator: (a: number | null, b: number | null) =>
                    (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER),
            },
            {
                colId: "title",
                headerName: "标题",
                field: "title",
                width: 220,
                editable: true,
                cellClass: "leading-5",
            },
            {
                colId: "author",
                headerName: "作者",
                width: 90,
                valueGetter: (params) => authorLabel(authorsRef.current, params.data?.authorId ?? null),
            },
            {
                colId: "category",
                headerName: "分类",
                width: 150,
                valueGetter: (params) =>
                    refsToNames(params.data?.terms["resource_category"], termsRef.current["resource_category"]),
            },
            {
                colId: "tags",
                headerName: "标签",
                width: 200,
                valueGetter: (params) =>
                    tagTaxonomies
                        .map((slug) => refsToNames(params.data?.terms[slug], termsRef.current[slug]))
                        .filter(Boolean)
                        .join("、"),
            },
            {
                colId: "dateLocal",
                headerName: "发布时间",
                field: "dateLocal",
                width: 150,
                editable: true,
                valueFormatter: (params) => (params.value ?? "").replace("T", " ").slice(0, 16),
                // Same rule as the ID column: an un-pushed row has no date yet,
                // and the default comparator would float that blank to the top
                // of an ascending sort. It ranks as the newest date instead.
                comparator: (a: string | null, b: string | null) => {
                    const left = a == null || a === "" ? "\uffff" : a;
                    const right = b == null || b === "" ? "\uffff" : b;
                    return left < right ? -1 : left > right ? 1 : 0;
                },
            },
            {
                colId: "fileserve",
                headerName: "文件列表",
                width: 110,
                valueGetter: (params) => configSummary((params.data?.fileserveParsed ?? null) as never),
            },
        ];
        // Built once on purpose: see the termsRef/authorsRef note above. The
        // valueGetters read the refs, so a stale def is not a stale value.
    }, []);

    // Stable identity: AG Grid compares this callback by reference on every
    // render, like the other handlers below.
    const onCellValueChanged = useCallback(
        (event: CellValueChangedEvent<RowDTO>) => {
            const row = event.data;
            if (!row) {
                return;
            }
            const field = event.colDef.field;
            if (field === "title") {
                onEdit(row.localId, { title: row.title });
            } else if (field === "dateLocal") {
                onEdit(row.localId, { dateLocal: row.dateLocal });
            }
        },
        [onEdit],
    );

    // The column state is applied once, when the grid is ready — columnDefs
    // never changes identity, so AG Grid never rebuilds the columns and never
    // resets the arrangement behind the user's back.
    const apiRef = useRef<GridApi<RowDTO> | null>(null);

    // Stable identities: like defaultColDef, a fresh callback object per
    // render is only churn for the grid wrapper.
    const getRowId = useCallback((params: { data?: RowDTO }) => String(params.data!.localId), []);

    const onGridReady = useCallback((event: GridReadyEvent<RowDTO>) => {
        apiRef.current = event.api;
        applySavedColumnState(event.api);
    }, []);

    const onColumnResized = useCallback((event: ColumnResizedEvent<RowDTO>) => {
        if (event.finished && isUserColumnEvent(event.source)) {
            persistColumnState(event.api);
        }
    }, []);

    const onColumnMoved = useCallback((event: ColumnMovedEvent<RowDTO>) => {
        if (event.finished && isUserColumnEvent(event.source)) {
            persistColumnState(event.api);
        }
    }, []);

    const onSortChanged = useCallback((event: SortChangedEvent<RowDTO>) => {
        if (isUserColumnEvent(event.source)) {
            persistColumnState(event.api);
        }
    }, []);

    const onRowClicked = useCallback(
        (event: { data?: RowDTO }) => {
            const id = event.data?.localId;
            if (id !== undefined) {
                onSelect(id);
            }
        },
        [onSelect],
    );

    // A pull or an import replaces the term registry and the author list.
    // columnDefs stays put, so hand the new maps to the valueGetters' refs and
    // force the cells that read them to re-render.
    useEffect(() => {
        termsRef.current = terms;
        authorsRef.current = authors;
        apiRef.current?.refreshCells({ force: true });
    }, [terms, authors]);

    // The App owns the selection — 新建行 selects the new row, 删除 clears it —
    // but AG Grid keeps a selection of its own, so without this the panel could
    // be editing one row while the grid highlighted another, or none.
    useEffect(() => {
        apiRef.current?.forEachNode((node) => {
            const shouldSelect = node.id === String(selectedId);
            if (node.isSelected() !== shouldSelect) {
                node.setSelected(shouldSelect);
            }
        });
    }, [selectedId, rows]);

    // A freshly created row sits last in the server's local_id order, so on a
    // long table it lands far below the fold and 新建行 looked like it did
    // nothing. Bring it into view once it actually reaches the row data — the
    // effect re-runs as rows arrive, and the ref keeps it to a single scroll.
    const scrolledTo = useRef<number | null>(null);
    useEffect(() => {
        const api = apiRef.current;
        if (api === null || scrollToId === null || scrolledTo.current === scrollToId) {
            return;
        }
        const node = api.getRowNode(String(scrollToId));
        if (!node) {
            return;
        }
        scrolledTo.current = scrollToId;
        if (node.rowIndex !== null) {
            api.ensureIndexVisible(node.rowIndex, "bottom");
        }
    }, [scrollToId, rows]);

    return (
        <div className="h-full">
            <AgGridReact<RowDTO>
                rowData={rows}
                columnDefs={columnDefs}
                rowSelection="single"
                getRowId={getRowId}
                onGridReady={onGridReady}
                onColumnResized={onColumnResized}
                onColumnMoved={onColumnMoved}
                onSortChanged={onSortChanged}
                onCellValueChanged={onCellValueChanged}
                onRowClicked={onRowClicked}
                defaultColDef={DEFAULT_COL_DEF}
                headerHeight={30}
                rowHeight={30}
            />
        </div>
    );
}
