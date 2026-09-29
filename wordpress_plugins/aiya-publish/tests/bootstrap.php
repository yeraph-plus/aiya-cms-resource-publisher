<?php

declare(strict_types=1);

/*
 * Minimal WordPress shims for the unit tests, in the spirit of the aiya-core
 * test suite: an in-memory post/meta/term store and identity timezone helpers
 * (the site clock reads as UTC), just enough for the model and REST support
 * classes to run as pure functions.
 */

define('ABSPATH', __DIR__ . '/');

spl_autoload_register(static function (string $class): void {
    $prefix = 'Aiya\\Publish\\';
    if (str_starts_with($class, $prefix)) {
        require_once __DIR__ . '/../src/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    }
});

$GLOBALS['__test'] = [
    'posts' => [],
    'meta' => [],
        'terms' => [],
        'postTerms' => [],
        'taxonomies' => [],
        'users' => [1, 2],
        'nextPostId' => 100,
        'nextTermId' => 100,
    'caps' => [],
    'userId' => 0,
];

function aiya_publish_test_reset(): void
{
    $GLOBALS['__test'] = [
        'posts' => [],
        'meta' => [],
        'terms' => [],
        'postTerms' => [],
        'taxonomies' => [],
        'users' => [1, 2],
        'nextPostId' => 100,
        'nextTermId' => 100,
        'caps' => ['edit_posts', 'edit_post', 'publish_posts', 'edit_others_posts', 'assign_terms', 'manage_terms'],
        'userId' => 1,
    ];
}

aiya_publish_test_reset();

final class WP_Error
{
    public array $errors = [];
    public array $error_data = [];

    public function __construct(?string $code = '', string $message = '', mixed $data = null)
    {
        if ($code !== null && $code !== '') {
            $this->errors[$code] = $message;
            if ($data !== null) {
                $this->error_data[$code] = $data;
            }
        }
    }

    public function get_error_message(?string $code = null): string
    {
        $code ??= array_key_first($this->errors);

        return $this->errors[$code] ?? '';
    }

    public function get_error_data(?string $code = null): mixed
    {
        $code ??= array_key_first($this->error_data);

        return $this->error_data[$code] ?? false;
    }

    public function has_errors(): bool
    {
        return $this->errors !== [];
    }
}

function is_wp_error(mixed $thing): bool
{
    return $thing instanceof WP_Error;
}

final class WP_Post
{
    public function __construct(
        public int $ID,
        public string $post_type = 'post',
        public string $post_status = 'draft',
        public string $post_title = '',
        public string $post_content = '',
        public int $post_author = 0,
        public string $post_date = '',
        public string $post_date_gmt = '',
        public string $post_modified = '',
        public string $post_modified_gmt = '',
    ) {}
}

final class WP_Term
{
    public function __construct(
        public int $term_id,
        public string $name,
        public string $slug,
        public string $taxonomy,
        public int $count = 0,
    ) {}
}

final class WP_Taxonomy
{
    public object $cap;
    public object $labels;

    public function __construct(
        public string $name,
        public bool $hierarchical = false,
    ) {
        $this->cap = (object) ['assign_terms' => 'assign_terms', 'manage_terms' => 'manage_terms'];
        $this->labels = (object) ['singular_name' => $name];
    }
}

function __(string $text, string $domain = 'default'): string
{
    return $text;
}

function wp_json_encode(mixed $data, int $flags = 0): string|false
{
    return json_encode($data, $flags);
}

function sanitize_text_field(string $str): string
{
    return trim(strip_tags($str));
}

function wp_slash(mixed $value): mixed
{
    return is_string($value) ? addslashes($value) : $value;
}

function wp_unslash(mixed $value): mixed
{
    return is_string($value) ? stripslashes($value) : $value;
}

function get_post_meta(int $postId, string $key, bool $single = false): mixed
{
    $value = $GLOBALS['__test']['meta'][$postId][$key] ?? '';
    if (!$single) {
        return [$value];
    }

    return $value;
}

function update_post_meta(int $postId, string $key, mixed $value): bool
{
    // Real WP expects slashed data and unslashes it before storing.
    $GLOBALS['__test']['meta'][$postId][$key] = wp_unslash($value);

    return true;
}

function delete_post_meta(int $postId, string $key): bool
{
    unset($GLOBALS['__test']['meta'][$postId][$key]);

    return true;
}

function wp_insert_post(array $args, bool $wpError = false): int|WP_Error
{
    $id = (int) ($args['ID'] ?? 0);
    if ($id === 0) {
        $id = $GLOBALS['__test']['nextPostId']++;
    }
    $now = gmdate('Y-m-d H:i:s');
    $GLOBALS['__test']['posts'][$id] = new WP_Post(
        $id,
        (string) ($args['post_type'] ?? 'post'),
        (string) ($args['post_status'] ?? 'draft'),
        (string) ($args['post_title'] ?? ''),
        (string) ($args['post_content'] ?? ''),
        (int) ($args['post_author'] ?? 0),
        (string) ($args['post_date'] ?? $now),
        (string) ($args['post_date_gmt'] ?? $now),
        (string) ($args['post_modified'] ?? $now),
        (string) ($args['post_modified_gmt'] ?? $now),
    );

    return $id;
}

function wp_update_post(array|object $args, bool $wpError = false): int|WP_Error
{
    $args = (array) $args;
    $id = (int) ($args['ID'] ?? 0);
    $post = $GLOBALS['__test']['posts'][$id] ?? null;
    if ($post === null) {
        return $wpError ? new WP_Error('invalid_post', 'Invalid post ID.') : 0;
    }
    foreach (['post_status', 'post_title', 'post_content', 'post_date', 'post_date_gmt', 'post_modified', 'post_modified_gmt'] as $field) {
        if (array_key_exists($field, $args)) {
            $post->$field = (string) $args[$field];
        }
    }
    if (array_key_exists('post_author', $args)) {
        $post->post_author = (int) $args['post_author'];
    }

    return $id;
}

function get_post(int|WP_Post|null $post = null): ?WP_Post
{
    if ($post === null) {
        return null;
    }
    if ($post instanceof WP_Post) {
        return $post;
    }

    return $GLOBALS['__test']['posts'][$post] ?? null;
}

function get_object_taxonomies(string $type, string $output = 'names'): array
{
    $objects = $GLOBALS['__test']['taxonomies'];
    if ($output === 'names') {
        return array_keys($objects);
    }

    return $objects;
}

function get_term(int $id, string $taxonomy): ?WP_Term
{
    $term = $GLOBALS['__test']['terms'][$id] ?? null;
    if ($term === null || $term->taxonomy !== $taxonomy) {
        return null;
    }

    return $term;
}

function get_term_by(string $field, string $value, string $taxonomy): ?WP_Term
{
    if ($field !== 'name') {
        return null;
    }
    foreach ($GLOBALS['__test']['terms'] as $term) {
        if ($term->taxonomy === $taxonomy && $term->name === $value) {
            return $term;
        }
    }

    return null;
}

function wp_insert_term(string $term, string $taxonomy, array $args = []): array|WP_Error
{
    $existing = get_term_by('name', $term, $taxonomy);
    if ($existing !== null) {
        return new WP_Error('term_exists', 'A term with the name provided already exists.', ['term_id' => $existing->term_id]);
    }
    $id = $GLOBALS['__test']['nextTermId']++;
    $GLOBALS['__test']['terms'][$id] = new WP_Term($id, $term, strtolower($term), $taxonomy);

    return ['term_id' => $id];
}

function wp_set_object_terms(int $postId, array $termIds, string $taxonomy, bool $append = false): void
{
    if (!$append) {
        unset($GLOBALS['__test']['postTerms'][$postId][$taxonomy]);
    }
    foreach ($termIds as $termId) {
        $GLOBALS['__test']['postTerms'][$postId][$taxonomy][(int) $termId] = true;
    }
}

function wp_get_object_terms(int $postId, array $taxonomies): array|WP_Error
{
    $result = [];
    foreach ($GLOBALS['__test']['postTerms'][$postId] ?? [] as $taxonomy => $ids) {
        if (!in_array($taxonomy, $taxonomies, true)) {
            continue;
        }
        foreach (array_keys($ids) as $termId) {
            $term = $GLOBALS['__test']['terms'][$termId] ?? null;
            if ($term !== null) {
                $result[] = $term;
            }
        }
    }

    return $result;
}

function get_current_user_id(): int
{
    return $GLOBALS['__test']['userId'];
}

function is_user_logged_in(): bool
{
    return $GLOBALS['__test']['userId'] > 0;
}

function current_user_can(string $capability, int ...$args): bool
{
    return in_array($capability, $GLOBALS['__test']['caps'], true);
}

function get_userdata(int $id): object|false
{
    return in_array($id, $GLOBALS['__test']['users'], true) ? (object) ['ID' => $id] : false;
}

// Identity timezone helpers: the test site clock reads as UTC.
function get_gmt_from_date(string $date, string $format = 'Y-m-d H:i:s'): string
{
    return $date;
}

function get_date_from_gmt(string $gmt, string $format = 'Y-m-d H:i:s'): string
{
    return $gmt;
}

function mysql_to_rfc3339(string $mysql): string
{
    return str_replace(' ', 'T', $mysql) . '+00:00';
}

function get_permalink(WP_Post|int $post): string|false
{
    $id = $post instanceof WP_Post ? $post->ID : $post;

    return 'http://example.test/?p=' . $id;
}

function get_the_author_meta(string $field, int $userId): string
{
    return 'Author ' . $userId;
}

function post_type_exists(string $type): bool
{
    return $type === 'resource';
}
