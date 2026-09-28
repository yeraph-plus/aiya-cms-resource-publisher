<?php

declare(strict_types=1);

namespace Aiya\Publish\Model;

use WP_Error;

/**
 * Field-by-field validation for the create/update payloads. Every check
 * returns its value or a WP_Error carrying the REST status, so the writer can
 * short-circuit and the API always answers with a precise 400/403.
 */
final class Payload
{
    public const STATUSES = ['publish', 'draft'];

    public static function title(mixed $value): string|WP_Error
    {
        $title = trim(sanitize_text_field((string) ($value ?? '')));
        if ($title === '') {
            return self::invalid(__('A title is required.', 'aiya-publish'));
        }

        return $title;
    }

    /** The body is stored as the tool handed it in; rendering belongs to WordPress. */
    public static function content(mixed $value): string
    {
        return (string) ($value ?? '');
    }

    /** @return string|WP_Error One of STATUSES; '' reads as the default 'publish'. */
    public static function status(mixed $value): string|WP_Error
    {
        $status = is_string($value) && $value !== '' ? $value : 'publish';
        if (!in_array($status, self::STATUSES, true)) {
            return self::invalid(__('Status must be publish or draft.', 'aiya-publish'));
        }

        return $status;
    }

    /** @return int|WP_Error */
    public static function authorId(mixed $value): int|WP_Error
    {
        if ($value === null || $value === '') {
            return get_current_user_id();
        }
        if (!is_numeric($value) || (int) $value < 1) {
            return self::invalid(__('The authorId must be a positive user id.', 'aiya-publish'));
        }

        $authorId = (int) $value;
        if (get_userdata($authorId) === false) {
            return self::invalid(__('The authorId does not name an existing user.', 'aiya-publish'));
        }
        if ($authorId !== get_current_user_id() && !current_user_can('edit_others_posts')) {
            return new WP_Error(
                'aiya_publish_forbidden_author',
                __('Assigning a post to another author requires the edit_others_posts capability.', 'aiya-publish'),
                ['status' => 403],
            );
        }

        return $authorId;
    }

    /**
     * The publish/update moment: an explicit date/dateGmt from the payload,
     * or the current time. A local date is taken at face value — the site's
     * own wall clock — and a GMT date is converted into the pair, so the
     * caller never has to know the site's timezone.
     *
     * @param array<string, mixed> $payload
     * @return array{date: string, gmt: string}|WP_Error Two 'Y-m-d H:i:s' strings.
     */
    public static function dates(array $payload): array|WP_Error
    {
        // null reads as "not provided"; anything non-string is malformed.
        foreach (['date', 'dateGmt'] as $field) {
            $value = $payload[$field] ?? null;
            if ($value !== null && !is_string($value)) {
                /* translators: %s: field name. */
                return self::invalid(sprintf(__('The %s must be a datetime string.', 'aiya-publish'), $field));
            }
        }

        $hasLocal = ($payload['date'] ?? null) !== null && $payload['date'] !== '';
        $hasGmt = ($payload['dateGmt'] ?? null) !== null && $payload['dateGmt'] !== '';

        if ($hasLocal) {
            $local = self::mysqlDate($payload['date']);
            if ($local === null) {
                return self::invalid(__('The date is not a readable datetime.', 'aiya-publish'));
            }

            return ['date' => $local, 'gmt' => get_gmt_from_date($local)];
        }

        if ($hasGmt) {
            $gmt = self::mysqlDate($payload['dateGmt']);
            if ($gmt === null) {
                return self::invalid(__('The dateGmt is not a readable datetime.', 'aiya-publish'));
            }

            return ['date' => get_date_from_gmt($gmt, 'Y-m-d H:i:s'), 'gmt' => $gmt];
        }

        $gmt = gmdate('Y-m-d H:i:s');

        return ['date' => get_date_from_gmt($gmt, 'Y-m-d H:i:s'), 'gmt' => $gmt];
    }

    /**
     * Accepts "YYYY-MM-DDTHH:MM[:SS]" or "YYYY-MM-DD HH:MM[:SS]" as a literal
     * wall-clock value — no timezone guessing — and returns the 'Y-m-d H:i:s'
     * form, or null when the value is not a real point in time.
     */
    private static function mysqlDate(string $value): ?string
    {
        $value = str_replace('T', ' ', trim($value));
        if (preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/', $value) !== 1) {
            return null;
        }
        if (strlen($value) === 16) {
            $value .= ':00';
        }

        [$day, $clock] = explode(' ', $value, 2);
        [$year, $month, $dayOfMonth] = array_map('intval', explode('-', $day));
        [$hour, $minute, $second] = array_map('intval', explode(':', $clock));
        if (!checkdate($month, $dayOfMonth, $year) || $hour > 23 || $minute > 59 || $second > 59) {
            return null;
        }

        return $value;
    }

    private static function invalid(string $message): WP_Error
    {
        return new WP_Error('aiya_publish_invalid_payload', $message, ['status' => 400]);
    }
}
