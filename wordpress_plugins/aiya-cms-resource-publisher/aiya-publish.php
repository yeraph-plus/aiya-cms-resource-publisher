<?php
/**
 * Plugin Name: AIYA CMS - Resource Post Publisher
 * Description: REST API (aiya-publish/v1) for an external publishing tool to create and update resource posts, including the FileServe data field. Application password required; anonymous callers are rejected. Companion plugin of the local publisher tool — requires the AIYA CMS - Headless Core plugin, which registers the resource post type this API serves.
 * Version: 0.1.0
 * Requires at least: 6.5
 * Requires PHP: 8.5
 * Requires Plugins: aiya-cms-core
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

/*
 * The whole surface serves the `resource` post type, which only exists with
 * aiya-core active. "Requires Plugins" already blocks activation in the
 * admin, but a CLI activation or an old WordPress would slip past it — so
 * degrade to a notice and no routes instead of registering a dead API.
 */
if (!defined('AIYA_CORE_VERSION')) {
    add_action('admin_notices', static function (): void {
        echo '<div class="notice notice-error"><p>',
            esc_html__('AIYA Publisher requires the AIYA CMS - Headless Core plugin, which is not active. The publishing API is disabled.', 'aiya-publish'),
            '</p></div>';
    });

    return;
}

add_action('rest_api_init', static function (): void {
    (new Rest\ResourceController())->registerRoutes();
});
