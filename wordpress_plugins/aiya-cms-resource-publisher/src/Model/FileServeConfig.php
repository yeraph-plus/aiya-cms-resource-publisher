<?php

declare(strict_types=1);

namespace Aiya\Publish\Model;

use WP_Error;

/**
 * A faithful replica of the FileServe domain's stored post meta (aiya-core
 * `Domain/FileServe/Config`): one JSON object keyed by auto-generated short
 * ids, every group naming its `adapter` and carrying that adapter's own
 * fields plus the common title/price pair.
 *
 * The publishing tool writes this meta wholesale, so the normalization
 * semantics are replicated here rather than reaching into aiya-core: unknown
 * keys are dropped, defaults fill the gaps, and any invalid group refuses the
 * whole save. The stored value is one JSON string, exactly like the metabox
 * writes it.
 */
final class FileServeConfig
{
    public const META_KEY = 'aiya_core_fileserve';

    /**
     * The adapters' own fields, in table order. Mirrors the domain's adapters
     * field by field.
     */
    private const ADAPTER_FIELDS = [
        'platform' => [
            ['id' => 'url', 'type' => 'text', 'default' => ''],
            ['id' => 'code', 'type' => 'text', 'default' => ''],
        ],
        'openlist_list' => [
            ['id' => 'path', 'type' => 'text', 'default' => ''],
            ['id' => 'password', 'type' => 'text', 'default' => ''],
            ['id' => 'per_page', 'type' => 'number', 'default' => 0, 'min' => 0],
        ],
        'openlist_search' => [
            ['id' => 'keywords', 'type' => 'text', 'default' => ''],
            ['id' => 'parent', 'type' => 'text', 'default' => ''],
            ['id' => 'password', 'type' => 'text', 'default' => ''],
            ['id' => 'per_page', 'type' => 'number', 'default' => 0, 'min' => 0],
        ],
        'gofile_api' => [
            ['id' => 'folder_id', 'type' => 'text', 'default' => ''],
        ],
    ];

    /**
     * The fields every group carries on top of its adapter's own.
     */
    private const COMMON_FIELDS = [
        ['id' => 'title', 'type' => 'text', 'default' => ''],
        ['id' => 'price', 'type' => 'number', 'default' => 0, 'min' => 0],
    ];

    /**
     * Normalizes a submitted configuration — a JSON string, an already
     * decoded array, or one of the empty shapes — into the canonical stored
     * shape. Any error means the caller must not store anything.
     *
     * @return array<string, array<string, mixed>>|WP_Error
     */
    public static function normalize(mixed $raw): array|WP_Error
    {
        if ($raw === null || $raw === '' || $raw === [] || $raw === false) {
            return [];
        }

        $decoded = is_string($raw) ? json_decode($raw, true) : $raw;
        if ($decoded instanceof \stdClass) {
            // A hand-crafted payload may carry the config as an object.
            $decoded = (array) $decoded;
        }
        if (!is_array($decoded)) {
            return new WP_Error(
                'aiya_publish_fileserve_invalid',
                __('The file configuration could not be read.', 'aiya-publish'),
                ['status' => 400],
            );
        }

        $config = [];
        $errors = [];

        foreach ($decoded as $rawId => $group) {
            $id = self::id((string) $rawId);
            if ($id === '') {
                $errors[] = __('A data group key could not be read.', 'aiya-publish');
                continue;
            }
            if (!is_array($group)) {
                /* translators: %s: data group id. */
                $errors[] = sprintf(__('Data group %s could not be read.', 'aiya-publish'), $id);
                continue;
            }

            $adapter = (string) ($group['adapter'] ?? '');
            $fields = self::ADAPTER_FIELDS[$adapter] ?? null;
            if ($fields === null) {
                /* translators: 1: data group id, 2: adapter id. */
                $errors[] = sprintf(
                    /* translators: 1: data group id, 2: adapter id. */
                    __('Data group %1$s names an adapter that is not available: %2$s', 'aiya-publish'),
                    $id,
                    $adapter === '' ? __('(none)', 'aiya-publish') : $adapter,
                );
                continue;
            }

            $group = self::normalizeGroup([...$fields, ...self::COMMON_FIELDS], $group);
            if ($group instanceof WP_Error) {
                /* translators: 1: data group id, 2: error message. */
                $errors[] = sprintf(__('Data group %1$s: %2$s', 'aiya-publish'), $id, $group->get_error_message());
                continue;
            }

            $group['adapter'] = $adapter;
            $config[$id] = $group;
        }

        if ($errors !== []) {
            return new WP_Error('aiya_publish_fileserve_invalid', implode(' ', $errors), ['status' => 400]);
        }

        return $config;
    }

    /**
     * The tool's round-trip view of what a post stores: the decoded JSON, or
     * null when the post carries no readable file configuration.
     *
     * @return array<string, mixed>|null
     */
    public static function present(int $postId): ?array
    {
        $raw = get_post_meta($postId, self::META_KEY, true);
        if (is_array($raw)) {
            return $raw === [] ? null : $raw;
        }
        if (!is_string($raw) || $raw === '') {
            return null;
        }
        $decoded = json_decode($raw, true);

        return is_array($decoded) && $decoded !== [] ? $decoded : null;
    }

    /**
     * The stored representation of one configuration: '' when empty (the
     * caller then deletes the meta), one JSON string otherwise.
     *
     * @param array<string, array<string, mixed>> $config
     */
    public static function encode(array $config): string
    {
        if ($config === []) {
            return '';
        }

        return (string) wp_json_encode($config, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    /**
     * A key-order-insensitive fingerprint of a configuration, so "did the
     * file data actually change" survives regrouping the same groups.
     *
     * @param array<string, mixed> $config
     */
    public static function canonical(array $config): string
    {
        self::sortKeys($config);

        return (string) wp_json_encode($config, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    /**
     * @param list<array{id: string, type: string, default: mixed, min?: float}> $fields
     * @param array<string, mixed> $group
     * @return array<string, mixed>|WP_Error
     */
    private static function normalizeGroup(array $fields, array $group): array|WP_Error
    {
        $normalized = [];
        foreach ($fields as $field) {
            $key = $field['id'];
            if (!array_key_exists($key, $group) || $group[$key] === null) {
                $normalized[$key] = $field['default'];
                continue;
            }
            $value = $group[$key];

            if ($field['type'] === 'text') {
                $normalized[$key] = sanitize_text_field((string) $value);
                continue;
            }

            // A number: '' reads as null, numeric strings are accepted,
            // anything else refuses the save.
            if ($value === '') {
                $normalized[$key] = null;
                continue;
            }
            if (!is_numeric($value)) {
                return new WP_Error(
                    'aiya_publish_fileserve_field',
                    /* translators: %s: field id. */
                    sprintf(__('Field %s is not a number.', 'aiya-publish'), $key),
                    ['status' => 400],
                );
            }
            $number = (float) $value;
            if (isset($field['min'])) {
                $number = max($field['min'], $number);
            }
            $normalized[$key] = $number;
        }

        // The domain folds the price to a whole non-negative int after
        // normalization.
        $normalized['price'] = max(0, (int) ($normalized['price'] ?? 0));

        return $normalized;
    }

    /** A submitted key reduced to something storable; '' when nothing is left of it. */
    private static function id(string $raw): string
    {
        $id = (string) preg_replace('/[^A-Za-z0-9_-]/', '', $raw);

        return substr($id, 0, 16);
    }

    /** @param array<string, mixed> $config */
    private static function sortKeys(array &$config): void
    {
        ksort($config);
        foreach ($config as &$value) {
            if (is_array($value)) {
                self::sortKeys($value);
            }
        }
    }
}
