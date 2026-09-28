<?php
/**
 * Plugin Name: AIYA Publisher
 * Description: REST API (aiya-publish/v1) for an external publishing tool to create and update resource posts, including the FileServe data field. Application password required; anonymous callers are rejected.
 * Version: 0.1.0
 * Requires at least: 6.4
 * Requires PHP: 8.5
 * Author: Yeraph
 * License: GPL-3.0-or-later
 * Update URI: false
 * Text Domain: aiya-publish
 */

declare(strict_types=1);

namespace Aiya\Publish;

defined('ABSPATH') || exit;

define('AIYA_PUBLISH_VERSION', '0.1.0');
define('AIYA_PUBLISH_FILE', __FILE__);
define('AIYA_PUBLISH_PATH', __DIR__ . '/');

spl_autoload_register(static function (string $className): void {
    $prefix = __NAMESPACE__ . '\\';
    if (!str_starts_with($className, $prefix)) {
        return;
    }
    $path = AIYA_PUBLISH_PATH . 'src/' . str_replace('\\', '/', substr($className, strlen($prefix))) . '.php';
    if (is_file($path)) {
        require_once $path;
    }
});

add_action('rest_api_init', static function (): void {
    (new Rest\ResourceController())->registerRoutes();
});
