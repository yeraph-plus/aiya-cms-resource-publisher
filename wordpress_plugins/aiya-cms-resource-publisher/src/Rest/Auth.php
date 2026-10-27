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
    /**
     * The floor for the whole surface: editors and administrators only.
     *
     * This is an editorial tool, not an authoring one. The list route exposes
     * the entire library including other people's drafts, so the gate has to
     * be role-level (`edit_others_posts`) rather than per-object `edit_posts`:
     * a contributor or author account holding an application password would
     * otherwise read drafts, private posts and their download payloads by id.
     * Editor in a stock WordPress install carries `edit_others_posts`,
     * `publish_posts`, `read_private_posts` and `upload_files`; an
     * administrator carries all of them too.
     */
    public const EDITOR = 'edit_others_posts';

    public static function require(string ...$capabilities): bool|WP_Error
    {
        if (!is_user_logged_in()) {
            return new WP_Error(
                'aiya_publish_unauthorized',
                __('Authentication is required; use an application password as the REST credentials.', 'aiya-publish'),
                ['status' => 401],
            );
        }

        foreach ($capabilities as $capability) {
            if (!current_user_can($capability)) {
                return new WP_Error(
                    'aiya_publish_forbidden',
                    __('Your account does not have the required capability.', 'aiya-publish'),
                    ['status' => 403],
                );
            }
        }

        return true;
    }
}
