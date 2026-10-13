<?php

declare(strict_types=1);

namespace Aiya\Publish\Tests\Unit;

use Aiya\Publish\Model\PicBedBridge;
use Aiya\Publish\Rest\UploadsController;
use PHPUnit\Framework\Attributes\Before;
use PHPUnit\Framework\TestCase;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;

/**
 * The upload route's own transport: the capability gate, the empty-file
 * refusal, and the pass-through of whatever the pic-bed pipeline answered.
 * The storing itself belongs to aiya-core (Model\PicBedBridge), so it is
 * injected here — this suite runs without core loaded.
 */
final class UploadsControllerTest extends TestCase
{
    private const ROUTE = 'aiya-publish/v1/uploads/image';

    #[Before]
    public function reset(): void
    {
        aiya_publish_test_reset();
        $GLOBALS['__test']['routes'] = [];
        $GLOBALS['__test']['caps'] = ['edit_posts', 'upload_files'];
    }

    /** @return array<string, mixed> The route table entry as recorded. */
    private function route(): array
    {
        self::assertArrayHasKey(self::ROUTE, $GLOBALS['__test']['routes']);

        return $GLOBALS['__test']['routes'][self::ROUTE];
    }

    /** @return mixed The callback's answer, whatever shape it took. */
    private function answer(array $files, ?UploadsController $controller = null): mixed
    {
        $controller ??= new UploadsController(static fn (array $entry): array => [
            'image' => ['width' => 1200, 'height' => 800, 'mime' => 'image/png', 'title' => 'a.png'],
            'url' => 'https://example.test/wp-content/aiya_upload_pics/2026/10/a.png',
            'path' => 'aiya_upload_pics/2026/10/a.png',
        ]);
        $controller->registerRoutes();
        $callback = $this->route()['callback'];

        return $callback(new WP_REST_Request($files));
    }

    public function testTheRouteIsAPostOnThePublishNamespace(): void
    {
        (new UploadsController())->registerRoutes();
        $route = $this->route();

        self::assertSame('POST', $route['methods']);
        self::assertIsCallable($route['callback']);
        self::assertIsCallable($route['permission_callback']);
    }

    public function testThePermissionCallbackAsksForTheUploadCapability(): void
    {
        (new UploadsController())->registerRoutes();
        $permission = $this->route()['permission_callback'];

        self::assertTrue($permission());

        // A logged-in account without upload_files — the admin pic-bed
        // screen's gate, and therefore this route's.
        $GLOBALS['__test']['caps'] = ['edit_posts'];
        $refused = $permission();
        self::assertInstanceOf(WP_Error::class, $refused);
        self::assertSame(403, $refused->get_error_data()['status']);

        // Nobody at all.
        $GLOBALS['__test']['userId'] = 0;
        $anonymous = $permission();
        self::assertInstanceOf(WP_Error::class, $anonymous);
        self::assertSame(401, $anonymous->get_error_data()['status']);
    }

    public function testAStoredImageAnswersThePicBedShape(): void
    {
        $response = $this->answer(['image' => ['name' => 'a.png', 'tmp_name' => '/tmp/php1', 'size' => 128]]);

        self::assertInstanceOf(WP_REST_Response::class, $response);
        $data = $response->get_data();
        self::assertSame('aiya_upload_pics/2026/10/a.png', $data['path']);
        self::assertSame(1200, $data['image']['width']);
        self::assertSame('image/png', $data['image']['mime']);
        self::assertStringStartsWith('https://example.test/', $data['url']);
    }

    public function testARequestWithoutAFileIsRefused(): void
    {
        $response = $this->answer([]);

        self::assertInstanceOf(WP_Error::class, $response);
        self::assertSame('aiya_publish_upload_empty', array_key_first($response->errors));
        self::assertSame(400, $response->get_error_data()['status']);
    }

    public function testThePipelinesRejectionKeepsItsOwnStatus(): void
    {
        // Whatever the store refuses — an oversize file (413), a non-image
        // (415) — reaches the client with the status core chose.
        foreach ([413, 415] as $status) {
            $controller = new UploadsController(
                static fn (array $entry): WP_Error => new WP_Error(
                    'aiya_publish_upload_rejected',
                    'Rejected.',
                    ['status' => $status],
                ),
            );
            $response = $this->answer(['image' => ['name' => 'a.png', 'tmp_name' => '/tmp/php1']], $controller);

            self::assertInstanceOf(WP_Error::class, $response);
            self::assertSame($status, $response->get_error_data()['status']);
        }
    }

    public function testTheCeilingMatchesTheAdminPicBedScreen(): void
    {
        self::assertSame(10, PicBedBridge::MAX_SIZE_MB);
    }
}
