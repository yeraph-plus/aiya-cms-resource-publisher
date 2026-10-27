<?php

declare(strict_types=1);

namespace Aiya\Publish\Rest;

use Aiya\Publish\Model\PicBedBridge;
use Closure;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;

/**
 * Image upload for the publishing tool (`POST aiya-publish/v1/uploads/image`).
 *
 * One image posted in the `image` field lands in the site's pic-bed pool
 * through the same recipe the admin pic-bed screen uses — same destination
 * directory, same pipeline, same response shape — because the storing itself
 * is delegated to `Model\PicBedBridge`. Only the transport lives here: the
 * capability gate, the empty-file check and the WP_Error mapping.
 *
 * The store is injectable so the route can be unit-tested without aiya-core
 * loaded; the default resolves to the bridge.
 */
final class UploadsController
{
    /** @var Closure(array<string, mixed>): (array<string, mixed>|WP_Error) */
    private readonly Closure $picBed;

    /**
     * @param (Closure(array<string, mixed>): (array<string, mixed>|WP_Error))|null $picBed
     *        One `$_FILES`-shaped entry in, the presented upload or the rejection out.
     */
    public function __construct(?Closure $picBed = null)
    {
        $this->picBed = $picBed ?? static fn (array $entry): array|WP_Error => PicBedBridge::store($entry);
    }

    public function registerRoutes(): void
    {
        register_rest_route(ResourceController::API_NAMESPACE, '/uploads/image', [
            'methods' => WP_REST_Server::CREATABLE,
            'callback' => fn (WP_REST_Request $request): WP_Error|WP_REST_Response => $this->upload($request),
            // The admin pic-bed screen's capability; every author-level account
            // has it, so the tool's credentials can carry the upload too.
            'permission_callback' => fn (): bool|WP_Error => Auth::require(Auth::EDITOR, 'upload_files'),
        ]);
    }

    private function upload(WP_REST_Request $request): WP_Error|WP_REST_Response
    {
        $file = $request->get_file_params()['image'] ?? null;
        if (!is_array($file)) {
            return new WP_Error(
                'aiya_publish_upload_empty',
                __('No file was uploaded.', 'aiya-publish'),
                ['status' => 400],
            );
        }

        /** @var array<string, mixed> $file */
        $stored = ($this->picBed)($file);

        return $stored instanceof WP_Error ? $stored : new WP_REST_Response($stored);
    }
}
