<?php

declare(strict_types=1);

namespace Aiya\Publish\Rest;

use Aiya\Publish\Model\FileServeConfig;
use stdClass;
use WP_Post;

/**
 * One resource post projected into the publishing tool's row shape: raw
 * source content (rendering belongs to WordPress), the term map across every
 * taxonomy of the type, and the file configuration exactly as stored.
 */
final class ResourcePresenter
{
    /** @return array<string, mixed> */
    public static function present(WP_Post $post): array
    {
        $terms = [];
        $taxonomies = get_object_taxonomies($post->post_type, 'names');
        if ($taxonomies !== []) {
            $objects = wp_get_object_terms($post->ID, $taxonomies);
            if (!is_wp_error($objects)) {
                foreach ($objects as $term) {
                    $terms[$term->taxonomy][] = [
                        'id' => (int) $term->term_id,
                        'name' => $term->name,
                        'slug' => $term->slug,
                    ];
                }
            }
        }

        $link = get_permalink($post);

        return [
            'id' => (int) $post->ID,
            'status' => $post->post_status,
            'title' => $post->post_title,
            'content' => $post->post_content,
            'date' => mysql_to_rfc3339($post->post_date),
            'dateGmt' => mysql_to_rfc3339($post->post_date_gmt),
            'modified' => mysql_to_rfc3339($post->post_modified),
            'modifiedGmt' => mysql_to_rfc3339($post->post_modified_gmt),
            'link' => is_string($link) ? $link : '',
            'authorId' => (int) $post->post_author,
            'authorName' => (string) get_the_author_meta('display_name', (int) $post->post_author),
            'terms' => $terms === [] ? new stdClass() : $terms,
            'fileserve' => FileServeConfig::present((int) $post->ID),
        ];
    }
}
