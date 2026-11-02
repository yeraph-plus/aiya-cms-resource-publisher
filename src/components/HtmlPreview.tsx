import { useEffect, useMemo, useState } from "react";
import { buildPreviewDoc } from "../../shared/preview";

interface Props {
    content: string;
    /** Base for body-relative images; the site's own address. */
    siteUrl: string;
}

/**
 * The rendered body. Sandboxed without `allow-scripts`: the source can come
 * from the site, a CSV or an agent, and this page shares an origin with the
 * local API — a script that ran here could push, rewrite settings or delete
 * rows. Images still load (they are subresources, not script).
 */
export default function HtmlPreview({ content, siteUrl }: Props) {
    // The iframe reloads on every new srcDoc, so typing is debounced: a large
    // post would otherwise re-render the whole document on each keystroke.
    const [settled, setSettled] = useState(content);
    useEffect(() => {
        const timer = setTimeout(() => setSettled(content), 250);
        return () => clearTimeout(timer);
    }, [content]);

    const doc = useMemo(
        () =>
            buildPreviewDoc(settled, {
                siteUrl,
                localImageUrl: (path) =>
                    `${window.location.origin}/api/images/file?path=${encodeURIComponent(path)}`,
            }),
        [settled, siteUrl],
    );

    return (
        <iframe
            title="正文预览"
            className="w-full h-full bg-white border border-neutral-200 rounded"
            sandbox=""
            srcDoc={doc}
        />
    );
}
