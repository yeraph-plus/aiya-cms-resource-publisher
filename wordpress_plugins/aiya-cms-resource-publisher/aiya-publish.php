<?php
/**
 * Plugin Name: AIYA CMS - Resource Publisher API
 * Description: REST API (aiya-publish/v1) for an external publishing tool to create and update resource posts, including the FileServe data field. Application password required; anonymous callers are rejected. Companion plugin of the local publisher tool — requires the AIYA CMS - Headless Core plugin, which registers the resource post type this API serves.
 * Version: 0.1.1
 * Requires at least: 6.5
 * Requires PHP: 8.5
 * Author: Yeraph
 * License: GPL-3.0-or-later
 * Update URI: false
 * Text Domain: aiya-publish
 */

declare(strict_types=1);

namespace Aiya\Publish;

defined('ABSPATH') || exit;

define('AIYA_PUBLISH_VERSION', '0.1.1');
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
 * aiya-core active. No "Requires Plugins" header: the header matches by
 * folder slug and the core plugin is deployed under different folder names
 * (aiya-core locally, aiya-cms-core on production), so a slug-based header
 * would block activation on one side or the other. When core is missing the
 * guards below degrade to a notice and no routes instead of a dead API, and
 * they decide at hook-run time — WordPress loads active plugins in option
 * order, so a load-time AIYA_CORE_VERSION check could run before core.
 */
add_action('admin_notices', static function (): void {
    if (defined('AIYA_CORE_VERSION')) {
        return;
    }

    echo '<div class="notice notice-error"><p>',
        esc_html__('AIYA Publisher requires the AIYA CMS - Headless Core plugin, which is not active. The publishing API is disabled.', 'aiya-publish'),
        '</p></div>';
});

add_action('rest_api_init', static function (): void {
    if (!defined('AIYA_CORE_VERSION')) {
        return;
    }

    (new Rest\ResourceController())->registerRoutes();

    // The headless gate trims every namespace it does not know for callers
    // without publish_posts — announce ours so publisher sessions are
    // answered by their own capability checks instead of a blanket 404.
    add_filter('aiya_core_firstparty_rest_namespaces', static function (array $namespaces): array {
        $namespaces[] = '/' . Rest\ResourceController::API_NAMESPACE;

        return $namespaces;
    });
});
