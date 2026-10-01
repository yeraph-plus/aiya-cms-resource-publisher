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
import type { RowPatch } from "../api";

ModuleRegistry.registerModules([AllCommunityModule]);

const COLUMN_STATE_KEY = "publisher.gridColumnState.v1";

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

/** Apply the saved state, skipping ids that no longer exist in the current defs.
 * Columns are fixed-width (no flex), so a stale flex value in old saved states
 * must be dropped — a surviving flex lets a layout pass override user widths. */
function applySavedColumnState(api: GridApi<RowDTO>): void {
    const saved = loadColumnState();
    if (!saved) {
        return;
    }
    const known = new Set((api.getColumns() ?? []).map((column) => column.getColId()));
    const state = saved
        .filter((entry) => known.has(entry.colId))
        .map((entry) => ({ ...entry, flex: null }));
    if (state.length > 0) {
        api.applyColumnState({ state, applyOrder: true });
    }
}

interface Props {
    rows: RowDTO[];
    terms: Record<string, TermInfo[]>;
    authors: AuthorDTO[];
    selectedId: number | null;
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
            return found ? found.name : `#${ref}`;
        })
        .join("、");
}

export default function Grid({ rows, terms, authors, selectedId, onSelect, onEdit }: Props) {
    const authorName = (id: number | null): string => {
        if (id === null) {
            return "";
        }
        return authors.find((author) => author.id === id)?.name ?? `#${id}`;
    };

    const columnDefs = useMemo<ColDef<RowDTO>[]>(() => {
        const tagTaxonomies = TAXONOMY_ORDER.filter((slug) => slug !== "resource_category");
        return [
            {
                headerName: "标记",
                width: 110,
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
                                    className={`px-1 rounded text-[11px] ${
                                        badge === "冲突"
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
            { headerName: "ID", field: "postId", width: 70 },
            {
                headerName: "标题",
                field: "title",
                width: 220,
                editable: true,
                cellClass: "leading-5",
            },
            {
                headerName: "作者",
                width: 90,
                valueGetter: (params) => authorName(params.data?.authorId ?? null),
            },
            {
                headerName: "分类",
                width: 150,
                valueGetter: (params) => refsToNames(params.data?.terms["resource_category"], terms["resource_category"]),
            },
            {
                headerName: "标签",
                width: 200,
                valueGetter: (params) =>
                    tagTaxonomies
                        .map((slug) => refsToNames(params.data?.terms[slug], terms[slug]))
                        .filter(Boolean)
                        .join("、"),
            },
            {
                headerName: "发布时间",
                field: "dateLocal",
                width: 150,
                editable: true,
                valueFormatter: (params) => (params.value ?? "").replace("T", " ").slice(0, 16),
            },
            {
                headerName: "文件列表",
                width: 110,
                valueGetter: (params) => configSummary((params.data?.fileserveParsed ?? null) as never),
            },
            {
                headerName: "错误",
                field: "lastError",
                width: 160,
                cellClass: "text-red-600 text-xs",
                tooltipField: "lastError",
            },
        ];
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [terms, authors]);

    const onCellValueChanged = (event: CellValueChangedEvent<RowDTO>) => {
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
    };

    // Column state survives reloads and — the visible bug — the defs rebuild
    // each refresh causes: AG Grid answers a new columnDefs array by resetting
    // column state, so every debounced save riding on a row switch wiped the
    // user's widths. Re-apply the saved arrangement whenever defs change.
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

    // Re-apply the saved arrangement whenever the defs identity changes (a
    // refresh rebuilds terms/authors), so user widths outlive every rebuild.
    useEffect(() => {
        if (apiRef.current) {
            applySavedColumnState(apiRef.current);
        }
    }, [columnDefs]);

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
