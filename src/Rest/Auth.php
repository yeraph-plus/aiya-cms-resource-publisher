<?php

declare(strict_types=1);

namespace Aiya\Publish\Rest;

use WP_Error;

/**
 * Every route of this plugin serves the publishing tool only: a session
 * resolved by WordPress — an application password or an admin cookie — with
 * real editing capabilities. Anonymous callers get 401, authenticated callers
 * without the capability get 403.
 */
final class Auth
{
    public static function require(string $capability): bool|WP_Error
    {
        if (!is_user_logged_in()) {
            return new WP_Error(
                'aiya_publish_unauthorized',
                __('Authentication is required; use an application password as the REST credentials.', 'aiya-publish'),
                ['status' => 401],
            );
        }

        if (!current_user_can($capability)) {
            return new WP_Error(
                'aiya_publish_forbidden',
                __('Your account does not have the required capability.', 'aiya-publish'),
                ['status' => 403],
            );
        }

        return true;
    }
}
