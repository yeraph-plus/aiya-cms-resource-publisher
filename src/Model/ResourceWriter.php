<?php

declare(strict_types=1);

namespace Aiya\Publish\Model;

use Aiya\Publish\Rest\ResourcePresenter;
use Aiya\Publish\Rest\TermResolver;
use WP_Error;
use WP_Post;

/**
 * Create and update for the resource type. On update, every field the tool
 * does not send is left untouched; the file configuration is always written
 * wholesale, and when its value actually changes the publish moment moves to
 * now — the bump that makes a refreshed link set float the post back to the
 * top — unless the payload carries an explicit date.
 */
final class ResourceWriter
{
    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>|WP_Error The presented row on success.
     */
    public static function create(array $payload): array|WP_Error
    {
        $title = Payload::title($payload['title'] ?? null);
        if ($title instanceof WP_Error) {
            return $title;
        }
        $status = Payload::status($payload['status'] ?? null);
        if ($status instanceof WP_Error) {
            return $status;
        }
        if ($status === 'publish' && !current_user_can('publish_posts')) {
            return self::forbiddenPublish();
        }
        $authorId = Payload::authorId($payload['authorId'] ?? null);
        if ($authorId instanceof WP_Error) {
            return $authorId;
        }
        $dates = Payload::dates($payload);
        if ($dates instanceof WP_Error) {
            return $dates;
        }
        $terms = TermResolver::resolve($payload['terms'] ?? null);
        if ($terms instanceof WP_Error) {
            return $terms;
        }
        [$fileserve, $hasFileserve] = self::incomingFileserve($payload);
        if ($fileserve instanceof WP_Error) {
            return $fileserve;
        }

        $postId = wp_insert_post([
            'post_type' => 'resource',
            'post_status' => $status,
            'post_title' => $title,
            'post_content' => Payload::content($payload['content'] ?? null),
            'post_author' => $authorId,
            'post_date' => $dates['date'],
            'post_date_gmt' => $dates['gmt'],
            'post_modified' => $dates['date'],
            'post_modified_gmt' => $dates['gmt'],
        ], true);
        if (is_wp_error($postId)) {
            return new WP_Error('aiya_publish_write_failed', $postId->get_error_message(), ['status' => 500]);
        }

        foreach ($terms as $taxonomy => $ids) {
            wp_set_object_terms($postId, $ids, $taxonomy, false);
        }
        if ($hasFileserve) {
            self::storeFileserve($postId, $fileserve);
        }

        $post = self::find($postId);

        return $post instanceof WP_Error
            ? new WP_Error('aiya_publish_write_failed', __('The post could not be read back.', 'aiya-publish'), ['status' => 500])
            : ResourcePresenter::present($post);
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>|WP_Error The presented row on success.
     */
    public static function update(int $postId, array $payload): array|WP_Error
    {
        $post = self::find($postId);
        if ($post instanceof WP_Error) {
            return $post;
        }
        if (!current_user_can('edit_post', $postId)) {
            return new WP_Error(
                'aiya_publish_forbidden',
                __('You are not allowed to edit this post.', 'aiya-publish'),
                ['status' => 403],
            );
        }

        $args = ['ID' => $postId];

        if (array_key_exists('title', $payload)) {
            $title = Payload::title($payload['title']);
            if ($title instanceof WP_Error) {
                return $title;
            }
            $args['post_title'] = $title;
        }
        if (array_key_exists('content', $payload)) {
            $args['post_content'] = Payload::content($payload['content']);
        }
        if (array_key_exists('status', $payload)) {
            $status = Payload::status($payload['status']);
            if ($status instanceof WP_Error) {
                return $status;
            }
            if ($status === 'publish' && !current_user_can('publish_posts')) {
                return self::forbiddenPublish();
            }
            $args['post_status'] = $status;
        }
        if (array_key_exists('authorId', $payload)) {
            $authorId = Payload::authorId($payload['authorId']);
            if ($authorId instanceof WP_Error) {
                return $authorId;
            }
            $args['post_author'] = $authorId;
        }

        $explicitDates = array_key_exists('date', $payload) || array_key_exists('dateGmt', $payload);
        if ($explicitDates) {
            $dates = Payload::dates($payload);
            if ($dates instanceof WP_Error) {
                return $dates;
            }
            $args['post_date'] = $dates['date'];
            $args['post_date_gmt'] = $dates['gmt'];
        }

        $terms = TermResolver::resolve($payload['terms'] ?? null);
        if ($terms instanceof WP_Error) {
            return $terms;
        }
        [$fileserve, $hasFileserve] = self::incomingFileserve($payload);
        if ($fileserve instanceof WP_Error) {
            return $fileserve;
        }

        if ($hasFileserve && !$explicitDates && self::fileserveChanged($postId, $fileserve)) {
            $gmt = gmdate('Y-m-d H:i:s');
            $args['post_date'] = get_date_from_gmt($gmt, 'Y-m-d H:i:s');
            $args['post_date_gmt'] = $gmt;
        }

        if (count($args) > 1) {
            $updated = wp_update_post($args, true);
            if (is_wp_error($updated)) {
                return new WP_Error('aiya_publish_write_failed', $updated->get_error_message(), ['status' => 500]);
            }
        }

        if ($hasFileserve) {
            self::storeFileserve($postId, $fileserve);
        }
        foreach ($terms as $taxonomy => $ids) {
            wp_set_object_terms($postId, $ids, $taxonomy, false);
        }

        $fresh = self::find($postId);

        return $fresh instanceof WP_Error
            ? new WP_Error('aiya_publish_write_failed', __('The post could not be read back.', 'aiya-publish'), ['status' => 500])
            : ResourcePresenter::present($fresh);
    }

    /**
     * The resource post behind an id, or 404 — unknown ids, other post types,
     * and rows the tool cannot work with all answer the same "not there".
     */
    public static function find(int $postId): WP_Post|WP_Error
    {
        $post = get_post($postId);
        if (!$post instanceof WP_Post || $post->post_type !== 'resource' || in_array($post->post_status, ['trash', 'auto-draft'], true)) {
            return new WP_Error(
                'aiya_publish_not_found',
                __('No resource post with that id.', 'aiya-publish'),
                ['status' => 404],
            );
        }

        return $post;
    }

    /**
     * @param array<string, mixed> $payload
     * @return array{0: array<string, array<string, mixed>>|WP_Error, 1: bool}
     */
    private static function incomingFileserve(array $payload): array
    {
        if (!array_key_exists('fileserve', $payload) || $payload['fileserve'] === null) {
            return [[], false];
        }

        return [FileServeConfig::normalize($payload['fileserve']), true];
    }

    /**
     * True when the incoming configuration differs from what the post
     * stores. A stored value the normalizer refuses counts as empty, so a
     * non-empty incoming config repairs it (and bumps); an empty incoming
     * config over an absent one changes nothing.
     *
     * @param array<string, array<string, mixed>> $incoming
     */
    private static function fileserveChanged(int $postId, array $incoming): bool
    {
        $current = FileServeConfig::normalize(get_post_meta($postId, FileServeConfig::META_KEY, true));
        $currentConfig = $current instanceof WP_Error ? [] : $current;

        return FileServeConfig::canonical($incoming) !== FileServeConfig::canonical($currentConfig);
    }

    /**
     * @param array<string, array<string, mixed>> $config
     */
    private static function storeFileserve(int $postId, array $config): void
    {
        if ($config === []) {
            delete_post_meta($postId, FileServeConfig::META_KEY);

            return;
        }
        // The metabox stores one JSON string; mirror its slash handling so
        // quotes and backslashes inside the values survive the write.
        update_post_meta($postId, FileServeConfig::META_KEY, wp_slash(FileServeConfig::encode($config)));
    }

    private static function forbiddenPublish(): WP_Error
    {
        return new WP_Error(
            'aiya_publish_forbidden_publish',
            __('Publishing requires the publish_posts capability; send draft instead.', 'aiya-publish'),
            ['status' => 403],
        );
    }
}
