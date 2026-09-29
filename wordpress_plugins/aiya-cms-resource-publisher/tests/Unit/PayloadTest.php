<?php

declare(strict_types=1);

namespace Aiya\Publish\Tests\Unit;

use Aiya\Publish\Model\Payload;
use PHPUnit\Framework\Attributes\Before;
use PHPUnit\Framework\TestCase;
use WP_Error;

final class PayloadTest extends TestCase
{
    #[Before]
    public function reset(): void
    {
        aiya_publish_test_reset();
    }

    public function testTitleTrimsAndStripsTags(): void
    {
        self::assertSame('标题', Payload::title(' 标题 '));
        self::assertSame('标题', Payload::title('<b>标题</b>'));
    }

    public function testEmptyTitlesAreRefused(): void
    {
        self::assertInstanceOf(WP_Error::class, Payload::title(''));
        self::assertInstanceOf(WP_Error::class, Payload::title(null));
        self::assertInstanceOf(WP_Error::class, Payload::title('   '));
        self::assertInstanceOf(WP_Error::class, Payload::title('<b></b>'));
    }

    public function testContentPassesThroughAsIs(): void
    {
        self::assertSame('<p>正文</p>[post_id id="7"]', Payload::content('<p>正文</p>[post_id id="7"]'));
        self::assertSame('', Payload::content(null));
    }

    public function testStatusDefaultsToPublishAndAcceptsAllValues(): void
    {
        self::assertSame('publish', Payload::status(null));
        self::assertSame('publish', Payload::status(''));
        self::assertSame('draft', Payload::status('draft'));
        self::assertSame('publish', Payload::status('publish'));
        // A scheduled post echoes back through the tool without a 400.
        self::assertSame('future', Payload::status('future'));
        self::assertInstanceOf(WP_Error::class, Payload::status('private'));
    }

    public function testAuthorIdDefaultsToTheCurrentUser(): void
    {
        self::assertSame(1, Payload::authorId(null));
        self::assertSame(2, Payload::authorId(2));
    }

    public function testAuthorIdRejectsUnknownUsers(): void
    {
        self::assertInstanceOf(WP_Error::class, Payload::authorId(0));
        self::assertInstanceOf(WP_Error::class, Payload::authorId(-1));
        self::assertInstanceOf(WP_Error::class, Payload::authorId('abc'));
        // The shim has no user #99; get_userdata returns false.
        self::assertInstanceOf(WP_Error::class, Payload::authorId(99));
    }

    public function testAssigningAnotherAuthorNeedsTheCapability(): void
    {
        $GLOBALS['__test']['caps'] = ['edit_posts', 'publish_posts'];
        $error = Payload::authorId(2);
        self::assertInstanceOf(WP_Error::class, $error);
        self::assertSame('aiya_publish_forbidden_author', $error->errors ? array_key_first($error->errors) : '');

        $GLOBALS['__test']['caps'] = ['edit_posts', 'publish_posts', 'edit_others_posts'];
        self::assertSame(2, Payload::authorId(2));
        // One's own id never needs the capability.
        $GLOBALS['__test']['caps'] = ['edit_posts'];
        self::assertSame(1, Payload::authorId(1));
    }

    public function testNoDatesReadsAsNow(): void
    {
        $dates = Payload::dates([]);
        self::assertNotInstanceOf(WP_Error::class, $dates);
        self::assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $dates['date']);
        self::assertSame($dates['date'], $dates['gmt']);
    }

    public function testALocalDateIsPairedWithItsGmt(): void
    {
        $dates = Payload::dates(['date' => '2026-01-02T03:04']);
        self::assertNotInstanceOf(WP_Error::class, $dates);
        self::assertSame('2026-01-02 03:04:00', $dates['date']);
        self::assertSame('2026-01-02 03:04:00', $dates['gmt']);
    }

    public function testAGmtDateIsPairedWithItsLocal(): void
    {
        $dates = Payload::dates(['dateGmt' => '2026-01-02 03:04:05']);
        self::assertNotInstanceOf(WP_Error::class, $dates);
        self::assertSame('2026-01-02 03:04:05', $dates['gmt']);
        self::assertSame($dates['date'], $dates['gmt']);
    }

    public function testBrokenDatesAreRefused(): void
    {
        self::assertInstanceOf(WP_Error::class, Payload::dates(['date' => 'not a date']));
        self::assertInstanceOf(WP_Error::class, Payload::dates(['date' => '2026-02-30T00:00:00']));
        self::assertInstanceOf(WP_Error::class, Payload::dates(['date' => '2026-01-02T25:00']));
        self::assertInstanceOf(WP_Error::class, Payload::dates(['dateGmt' => '2026/01/02']));
        self::assertInstanceOf(WP_Error::class, Payload::dates(['date' => 12345]));
    }

    public function testALocalDateWinsOverAGmtDate(): void
    {
        $dates = Payload::dates(['date' => '2026-01-02T03:04', 'dateGmt' => '2026-05-06T07:08:09']);
        self::assertNotInstanceOf(WP_Error::class, $dates);
        self::assertSame('2026-01-02 03:04:00', $dates['date']);
    }
}
