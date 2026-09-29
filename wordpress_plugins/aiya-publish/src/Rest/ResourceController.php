<?php

declare(strict_types=1);

namespace Aiya\Publish\Rest;

use Aiya\Publish\Model\ResourceWriter;
use WP_Error;
use WP_Post;
use WP_Query;
use WP_REST_Request;
use WP_REST_Response;
use WP_REST_Server;
use WP_User_Query;

/**
 * The whole aiya-publish/v1 surface: a connection probe, the term registry of
 * the resource type, and list/single/create/update for resource posts. Plain
 * WordPress REST responses — no envelope of our own; errors are WP_Error
 * values carrying a status.
 */
final class ResourceController
{
    public const API_NAMESPACE = 'aiya-publish/v1';

    public function registerRoutes(): void
    {
        register_rest_route(self::API_NAMESPACE, '/ping', [
            [
                'methods' => WP_REST_Server::READABLE,
                'callback' => fn (): WP_REST_Response => $this->ping(),
                'permission_callback' => fn (): bool|WP_Error => Auth::require('edit_posts'),
            ],
        ]);

        register_rest_route(self::API_NAMESPACE, '/taxonomies', [
            [
                'methods' => WP_REST_Server::READABLE,
                'callback' => fn (): WP_REST_Response => $this->taxonomies(),
                'permission_callback' => fn (): bool|WP_Error => Auth::require('edit_posts'),
            ],
        ]);

        register_rest_route(self::API_NAMESPACE, '/users', [
            [
                'methods' => WP_REST_Server::READABLE,
                'callback' => fn (): WP_REST_Response => $this->users(),
                'permission_callback' => fn (): bool|WP_Error => Auth::require('edit_posts'),
            ],
        ]);

        register_rest_route(self::API_NAMESPACE, '/resource', [
            [
                'methods' => WP_REST_Server::READABLE,
                'callback' => fn (WP_REST_Request $request): WP_REST_Response|WP_Error => $this->listPosts($request),
                'permission_callback' => fn (): bool|WP_Error => Auth::require('edit_posts'),
                'args' => [
                    'page' => ['type' => 'integer', 'default' => 1, 'minimum' => 1],
                    'per_page' => ['type' => 'integer', 'default' => 20, 'minimum' => 1, 'maximum' => 100],
                    'modified_after' => ['type' => 'string'],
                ],
            ],
            [
                'methods' => WP_REST_Server::CREATABLE,
                'callback' => fn (WP_REST_Request $request): WP_REST_Response|WP_Error => $this->create($request),
                'permission_callback' => fn (): bool|WP_Error => Auth::require('edit_posts'),
            ],
        ]);

        register_rest_route(self::API_NAMESPACE, '/resource/(?P<id>\d+)', [
            [
                'methods' => WP_REST_Server::READABLE,
                'callback' => fn (WP_REST_Request $request): WP_REST_Response|WP_Error => $this->single($request),
                'permission_callback' => fn (): bool|WP_Error => Auth::require('edit_posts'),
                'args' => ['id' => ['type' => 'integer', 'minimum' => 1]],
            ],
            [
                'methods' => WP_REST_Server::EDITABLE,
                'callback' => fn (WP_REST_Request $request): WP_REST_Response|WP_Error => $this->update($request),
                'permission_callback' => fn (): bool|WP_Error => Auth::require('edit_posts'),
                'args' => ['id' => ['type' => 'integer', 'minimum' => 1]],
            ],
        ]);
    }

    private function ping(): WP_REST_Response
    {
        $user = wp_get_current_user();

        return new WP_REST_Response([
            'user' => [
                'id' => (int) $user->ID,
                'login' => $user->user_login,
                'name' => $user->display_name,
            ],
            'caps' => [
                'editPosts' => current_user_can('edit_posts'),
                'publishPosts' => current_user_can('publish_posts'),
                'editOthersPosts' => current_user_can('edit_others_posts'),
            ],
            'resourceAvailable' => post_type_exists('resource'),
            'version' => defined('AIYA_PUBLISH_VERSION') ? AIYA_PUBLISH_VERSION : '',
        ]);
    }

    /**
     * The accounts a post can be authored by: everyone with edit_posts
     * (author and up). The publishing tool picks an author per row from
     * this list; assigning one needs edit_others_posts at write time.
     */
    private function users(): WP_REST_Response
    {
        $query = new WP_User_Query([
            'capability__in' => ['edit_posts'],
            'orderby' => 'display_name',
            'order' => 'ASC',
            'number' => 500,
        ]);

        $items = [];
        foreach ($query->get_results() as $user) {
            $items[] = [
                'id' => (int) $user->ID,
                'login' => $user->user_login,
                'name' => $user->display_name !== '' ? $user->display_name : $user->user_login,
            ];
        }

        return new WP_REST_Response($items);
    }

    private function taxonomies(): WP_REST_Response
    {
        $items = [];
        foreach (get_object_taxonomies('resource', 'objects') as $taxonomy) {
            $terms = get_terms(['taxonomy' => $taxonomy->name, 'hide_empty' => false]);
            $list = [];
            if (!is_wp_error($terms)) {
                foreach ($terms as $term) {
                    $list[] = [
                        'id' => (int) $term->term_id,
                        'name' => $term->name,
                        'slug' => $term->slug,
                        'count' => (int) $term->count,
                    ];
                }
            }
            $items[] = [
                'slug' => $taxonomy->name,
                'hierarchical' => (bool) $taxonomy->hierarchical,
                'terms' => $list,
            ];
        }

        return new WP_REST_Response($items);
    }

    private function listPosts(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $perPage = min(100, max(1, (int) $request->get_param('per_page')));
        $queryArgs = [
            'post_type' => 'resource',
            // 'future' rides along so a scheduled post survives the sync.
            'post_status' => ['publish', 'draft', 'future'],
            'posts_per_page' => $perPage,
            'paged' => max(1, (int) $request->get_param('page')),
            'orderby' => 'ID',
            'order' => 'ASC',
        ];

        $modifiedAfter = $request->get_param('modified_after');
        if (is_string($modifiedAfter) && $modifiedAfter !== '') {
            $moment = strtotime($modifiedAfter);
            if ($moment === false) {
                // A "+" offset in the query string may arrive decoded as a space.
                $moment = strtotime(str_replace(' ', '+', $modifiedAfter));
            }
            if ($moment === false) {
                return new WP_Error(
                    'aiya_publish_invalid_param',
                    __('The modified_after parameter is not a readable datetime.', 'aiya-publish'),
                    ['status' => 400],
                );
            }
            $queryArgs['date_query'] = [
                [
                    'column' => 'post_modified_gmt',
                    'after' => gmdate('Y-m-d H:i:s', $moment),
                    'inclusive' => true,
                ],
            ];
        }

        $query = new WP_Query($queryArgs);
        $items = [];
        $posts = is_array($query->posts) ? $query->posts : [];
        foreach ($posts as $post) {
            if ($post instanceof WP_Post) {
                $items[] = ResourcePresenter::present($post);
            }
        }

        $response = new WP_REST_Response($items);
        $response->header('X-WP-Total', (string) $query->found_posts);
        $response->header('X-WP-TotalPages', (string) (int) ceil(max(1, (int) $query->found_posts) / $perPage));

        return $response;
    }

    private function single(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $post = ResourceWriter::find((int) $request['id']);

        return $post instanceof WP_Error ? $post : new WP_REST_Response(ResourcePresenter::present($post));
    }

    private function create(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $created = ResourceWriter::create(self::payload($request));
        if ($created instanceof WP_Error) {
            return $created;
        }

        return new WP_REST_Response($created, 201);
    }

    private function update(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $updated = ResourceWriter::update((int) $request['id'], self::payload($request));
        if ($updated instanceof WP_Error) {
            return $updated;
        }

        return new WP_REST_Response($updated);
    }

    /** The JSON body is the whole payload; an unreadable body reads as empty.
     *
     * @return array<string, mixed>
     */
    private function payload(WP_REST_Request $request): array
    {
        $body = $request->get_json_params();

        return is_array($body) ? $body : [];
    }
}
