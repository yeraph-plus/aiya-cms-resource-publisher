<?php

declare(strict_types=1);

namespace Aiya\Publish\Model;

use Aiya\Core\Api\Presenter\UploadPresenter;
use Aiya\Core\Domain\Media\PicBedStore;
use Aiya\Core\Domain\Media\UploadException;
use Aiya\Core\Modules\MediaModule;
use Aiya\Core\Settings\Registry;
use WP_Error;

/**
 * The single place this plugin touches aiya-core's code, and it touches only
 * the pic-bed stack.
 *
 * Images pushed by the publishing tool must land where the admin pic-bed
 * screen puts them and must be processed the same way, so the recipes are
 * borrowed rather than re-implemented: `MediaPaths::picBedDir()` is the dated
 * root under wp-content/aiya_upload_pics/, and `PicBedStore::store()` is the
 * shared pipeline (finfo MIME check, extension derived from the type, the
 * image-processor run with the watermark on, URL + content-relative key
 * facts). A second copy of either recipe here would drift from core the first
 * time either side changes.
 *
 * Composition comes from a throwaway MediaModule: `store()` and `paths()` are
 * plain accessors, so nothing registers core's hooks — `register()` is what
 * does that, and it is never called from here.
 *
 * Only public classes and their public methods are used; no core filter is
 * hooked. The entry file registers this route only when AIYA_CORE_VERSION is
 * defined, so these classes are guaranteed to be present when this runs.
 */
final class PicBedBridge
{
    /** The admin pic-bed screen's ceiling; the community upload route caps at 5MB. */
    public const MAX_SIZE_MB = 10;

    /**
     * Stores one uploaded file in the pic-bed pool.
     *
     * @param array<string, mixed> $file One entry of WP_REST_Request::get_file_params().
     * @return array<string, mixed>|WP_Error The presented upload, or the rejection
     *                                       carrying the pipeline's own HTTP status.
     */
    public static function store(array $file): array|WP_Error
    {
        $media = new MediaModule(new Registry());

        try {
            $stored = (new PicBedStore($media->store(), self::MAX_SIZE_MB * 1024 * 1024))
                ->store($file, $media->paths()->picBedDir(), (string) ($file['name'] ?? ''));
        } catch (UploadException $error) {
            return new WP_Error(
                'aiya_publish_upload_rejected',
                $error->getMessage(),
                ['status' => $error->httpStatus],
            );
        }

        /** @var array{url: string, path: string, width: int, height: int, mime: string|null, title: string} $stored */
        return (new UploadPresenter())->result(
            [$stored['width'], $stored['height'], 'mime' => $stored['mime']],
            $stored['title'],
            $stored['url'],
            $stored['path'],
        );
    }
}
