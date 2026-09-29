<?php

declare(strict_types=1);

namespace Aiya\Publish\Rest;

use WP_Error;
use WP_Taxonomy;
use WP_Term;

/**
 * Turns a payload's terms map — taxonomy slug → list of term ids or term
 * names — into term ids per taxonomy. A name that does not exist yet is
 * created, which needs the taxonomy's manage_terms capability; assigning
 * existing terms needs assign_terms.
 */
final class TermResolver
{
    /**
     * @return array<string, list<int>>|WP_Error
     */
    public static function resolve(mixed $payloadTerms): array|WP_Error
    {
        if ($payloadTerms === null) {
            return [];
        }
        if (!is_array($payloadTerms)) {
            return new WP_Error(
                'aiya_publish_invalid_payload',
                __('The terms must be an object keyed by taxonomy slug.', 'aiya-publish'),
                ['status' => 400],
            );
        }

        $taxonomies = get_object_taxonomies('resource', 'objects');
        $resolved = [];

        foreach ($payloadTerms as $taxonomy => $items) {
            $tax = is_string($taxonomy) ? ($taxonomies[$taxonomy] ?? null) : null;
            if (!$tax instanceof WP_Taxonomy || !is_array($items)) {
                return new WP_Error(
                    'aiya_publish_invalid_payload',
                    /* translators: %s: taxonomy slug. */
                    sprintf(__('Unknown taxonomy or malformed term list: %s', 'aiya-publish'), is_string($taxonomy) ? $taxonomy : '(not a string)'),
                    ['status' => 400],
                );
            }
            if (!current_user_can($tax->cap->assign_terms)) {
                return new WP_Error(
                    'aiya_publish_forbidden_terms',
                    /* translators: %s: taxonomy name. */
                    sprintf(__('You are not allowed to assign terms in %s.', 'aiya-publish'), $tax->name),
                    ['status' => 403],
                );
            }

            $ids = [];
            foreach ($items as $item) {
                if (is_int($item) || (is_string($item) && ctype_digit($item))) {
                    $term = get_term((int) $item, $tax->name);
                    if (!$term instanceof WP_Term) {
                        return new WP_Error(
                            'aiya_publish_invalid_payload',
                            /* translators: 1: term id, 2: taxonomy name. */
                            sprintf(__('Term #%1$s does not exist in %2$s.', 'aiya-publish'), (string) $item, $tax->name),
                            ['status' => 400],
                        );
                    }
                    $ids[] = (int) $term->term_id;
                    continue;
                }

                if (is_string($item)) {
                    $name = trim($item);
                    if ($name === '') {
                        return self::malformed($tax);
                    }
                    $existing = get_term_by('name', $name, $tax->name);
                    if ($existing instanceof WP_Term) {
                        $ids[] = (int) $existing->term_id;
                        continue;
                    }
                    if (!current_user_can($tax->cap->manage_terms)) {
                        return new WP_Error(
                            'aiya_publish_forbidden_terms',
                            sprintf(
                                /* translators: 1: taxonomy label, 2: capability name. */
                                __('Creating a new term in %1$s requires the %2$s capability.', 'aiya-publish'),
                                $tax->labels->singular_name,
                                $tax->cap->manage_terms,
                            ),
                            ['status' => 403],
                        );
                    }
                    $created = wp_insert_term($name, $tax->name);
                    if (is_wp_error($created)) {
                        // A concurrent write may have created the same name
                        // first; the error then carries the existing term.
                        $existingId = $created->get_error_data('term_exists');
                        if (is_array($existingId) && isset($existingId['term_id'])) {
                            $ids[] = (int) $existingId['term_id'];
                            continue;
                        }
                        return new WP_Error(
                            'aiya_publish_term_error',
                            sprintf(
                                /* translators: 1: term name, 2: taxonomy name, 3: error message. */
                                __('Term %1$s could not be created in %2$s: %3$s', 'aiya-publish'),
                                $name,
                                $tax->name,
                                $created->get_error_message(),
                            ),
                            ['status' => 400],
                        );
                    }
                    $ids[] = (int) $created['term_id'];
                    continue;
                }

                return self::malformed($tax);
            }

            $resolved[$tax->name] = array_values(array_unique($ids));
        }

        return $resolved;
    }

    private static function malformed(WP_Taxonomy $tax): WP_Error
    {
        return new WP_Error(
            'aiya_publish_invalid_payload',
            /* translators: %s: taxonomy name. */
            sprintf(__('The term list for %1$s must contain term ids or term names.', 'aiya-publish'), $tax->name),
            ['status' => 400],
        );
    }
}
