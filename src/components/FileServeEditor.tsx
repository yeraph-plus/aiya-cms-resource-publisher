import {
    ADAPTER_FIELDS,
    ADAPTER_LABELS,
    COMMON_FIELDS,
    emptyGroup,
    fieldLabel,
    nextId,
    priceDefault,
    type FieldValue,
    type FileServeConfig,
} from "../../shared/fileserve";

interface Props {
    config: FileServeConfig | null;
    onChange: (config: FileServeConfig | null) => void;
    /** Fires whenever a brand-new group id is added — the staging-dir trigger. */
    onGroupAdded?: () => void;
}

const ADAPTER_IDS = Object.keys(ADAPTER_FIELDS);

export default function FileServeEditor({ config, onChange, onGroupAdded }: Props) {
    const groups = config ?? {};
    const entries = Object.entries(groups).sort(([a], [b]) => Number(a) - Number(b));

    const commit = (next: FileServeConfig): void => {
        onChange(Object.keys(next).length > 0 ? next : {});
    };

    const addGroup = (): void => {
        const id = nextId(groups);
        commit({ ...groups, [id]: emptyGroup("platform") });
        onGroupAdded?.();
    };

    const removeGroup = (id: string): void => {
        const next = { ...groups };
        delete next[id];
        commit(next);
    };

    const changeAdapter = (id: string, adapter: string): void => {
        const previous = groups[id];
        if (!previous) {
            return;
        }
        // A price the user never touched (0 or the old adapter's default)
        // follows the new adapter's suggestion; a custom price and the push
        // flag survive.
        const untouched = (previous.price ?? 0) === 0 || previous.price === priceDefault(previous.adapter);
        commit({
            ...groups,
            [id]: {
                ...emptyGroup(adapter),
                title: previous.title ?? "",
                push: previous.push ?? false,
                ...(untouched ? {} : { price: previous.price ?? 0 }),
            },
        });
    };

    const setField = (id: string, field: string, value: FieldValue): void => {
        const group = groups[id];
        if (!group) {
            return;
        }
        commit({ ...groups, [id]: { ...group, [field]: value } });
    };

    return (
        <div className="space-y-2">
            {entries.map(([id, group]) => {
                const fields = [...(ADAPTER_FIELDS[group.adapter] ?? []), ...COMMON_FIELDS];
                return (
                    <div key={id} className="border border-neutral-200 rounded p-2 bg-neutral-50">
                        <div className="flex items-center gap-2 mb-1.5">
                            <span className="font-mono text-xs text-neutral-500">组 #{id}</span>
                            <select
                                value={group.adapter}
                                onChange={(event) => changeAdapter(id, event.target.value)}
                                className="text-xs"
                            >
                                {ADAPTER_IDS.map((adapter) => (
                                    <option key={adapter} value={adapter}>
                                        {ADAPTER_LABELS[adapter] ?? adapter}
                                    </option>
                                ))}
                            </select>
                            <span className="text-[11px] text-neutral-400">默认售价 {priceDefault(group.adapter)} 分</span>
                            <button
                                className="ml-auto text-xs text-red-500 hover:underline"
                                onClick={() => removeGroup(id)}
                            >
                                删除组
                            </button>
                        </div>
                        <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
                            {fields.map((field) => {
                                const wide =
                                    field.type === "text" && field.id !== "code" && field.id !== "password" && field.id !== "title";
                                return (
                                    <label key={field.id} className={wide ? "col-span-2" : "block"}>
                                        <span className="lbl">{fieldLabel(field.id)}</span>
                                        {field.type === "text" ? (
                                            <input
                                                className="w-full"
                                                value={String(group[field.id] ?? "")}
                                                onChange={(event) => setField(id, field.id, event.target.value)}
                                            />
                                        ) : (
                                            <input
                                                type="number"
                                                className="w-full"
                                                min={field.min}
                                                value={group[field.id] === null || group[field.id] === undefined ? "" : Number(group[field.id])}
                                                onChange={(event) =>
                                                    setField(id, field.id, event.target.value === "" ? null : Number(event.target.value))
                                                }
                                            />
                                        )}
                                    </label>
                                );
                            })}
                            {/* The per-group 推送 switch, styled as one more
                                field cell: unchecked = local draft, never
                                pushed; checked = rides with the main push. */}
                            <div className="block">
                                <span className="lbl">推送</span>
                                <label className="inline-flex items-center gap-1.5 cursor-pointer mt-0.5">
                                    <input
                                        type="checkbox"
                                        checked={group.push !== false}
                                        onChange={(event) => setField(id, "push", event.target.checked)}
                                    />
                                    <span className={group.push === false ? "text-neutral-400" : "text-neutral-700"}>
                                        {group.push === false ? "草稿（不推送）" : "随主推送"}
                                    </span>
                                </label>
                            </div>
                        </div>
                    </div>
                );
            })}

            <div className="space-y-1.5">
                <div className="flex items-center gap-3">
                    <button className="btn" onClick={addGroup}>
                        + 添加组
                    </button>
                    {entries.length === 0 && (
                        <span className="text-xs text-neutral-400">没有数据组（推送空配置会清除线上文件列表；新组默认不勾推送）</span>
                    )}
                </div>
                {entries.length > 0 && (
                    <details className="text-xs text-neutral-500">
                        <summary className="cursor-pointer select-none">JSON 预览</summary>
                        <pre className="mt-1 p-2 bg-neutral-900 text-green-200 rounded overflow-auto max-h-56 text-[11px] leading-4">
                            {JSON.stringify(groups, null, 2)}
                        </pre>
                    </details>
                )}
            </div>
        </div>
    );
}
