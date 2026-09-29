<?php

declare(strict_types=1);

namespace Aiya\Publish\Tests\Unit;

use Aiya\Publish\Model\FileServeConfig;
use PHPUnit\Framework\Attributes\Before;
use PHPUnit\Framework\TestCase;
use WP_Error;

final class FileServeConfigTest extends TestCase
{
    #[Before]
    public function reset(): void
    {
        aiya_publish_test_reset();
    }

    public function testEmptyShapesNormalizeToAnEmptyConfig(): void
    {
        self::assertSame([], FileServeConfig::normalize(null));
        self::assertSame([], FileServeConfig::normalize(''));
        self::assertSame([], FileServeConfig::normalize([]));
        self::assertSame([], FileServeConfig::normalize('{}'));
        self::assertSame([], FileServeConfig::normalize((object) []));
    }

    public function testAValidGroupIsNormalizedWithDefaultsFilledAndUnknownKeysDropped(): void
    {
        $config = FileServeConfig::normalize('{"1":{"adapter":"openlist_list","path":"/docs","extra":"junk","title":"文档","price":"5"}}');

        self::assertNotInstanceOf(WP_Error::class, $config);
        self::assertSame([
            'path' => '/docs',
            'password' => '',
            'per_page' => 0,
            'title' => '文档',
            'price' => 5,
            'adapter' => 'openlist_list',
        ], $config['1']);
    }

    public function testAnAlreadyDecodedArrayIsAccepted(): void
    {
        $config = FileServeConfig::normalize([
            '3' => ['adapter' => 'platform', 'url' => 'https://pan.example/s/abc', 'code' => 'x7k2', 'title' => '夸克', 'price' => 5],
        ]);

        self::assertNotInstanceOf(WP_Error::class, $config);
        self::assertSame('platform', $config['3']['adapter']);
        self::assertSame('x7k2', $config['3']['code']);
    }

    public function testAnUnknownAdapterRefusesTheWholeSave(): void
    {
        $config = FileServeConfig::normalize([
            '1' => ['adapter' => 'platform', 'url' => 'https://x'],
            '2' => ['adapter' => 'nope'],
        ]);

        self::assertInstanceOf(WP_Error::class, $config);
    }

    public function testANonNumericPriceRefusesTheWholeSave(): void
    {
        $config = FileServeConfig::normalize(['1' => ['adapter' => 'platform', 'price' => 'abc']]);

        self::assertInstanceOf(WP_Error::class, $config);
    }

    public function testPriceIsFoldedToANonNegativeInt(): void
    {
        $config = FileServeConfig::normalize(['1' => ['adapter' => 'platform', 'price' => 4.9]]);
        self::assertNotInstanceOf(WP_Error::class, $config);
        self::assertSame(4, $config['1']['price']);

        $config = FileServeConfig::normalize(['1' => ['adapter' => 'platform', 'price' => -5]]);
        self::assertNotInstanceOf(WP_Error::class, $config);
        self::assertSame(0, $config['1']['price']);
    }

    public function testNumbersReadEmptyAsNullAndNumericStringsAsNumbers(): void
    {
        $config = FileServeConfig::normalize(['1' => ['adapter' => 'openlist_list', 'per_page' => '', 'path' => '/x']]);
        self::assertNotInstanceOf(WP_Error::class, $config);
        self::assertNull($config['1']['per_page']);

        $config = FileServeConfig::normalize(['1' => ['adapter' => 'openlist_list', 'per_page' => '10', 'path' => '/x']]);
        self::assertNotInstanceOf(WP_Error::class, $config);
        self::assertSame(10.0, $config['1']['per_page']);
    }

    public function testGroupKeysAreSanitizedShortIds(): void
    {
        $config = FileServeConfig::normalize(['a b!!' => ['adapter' => 'platform']]);
        self::assertNotInstanceOf(WP_Error::class, $config);
        self::assertSame(['ab'], array_keys($config));
    }

    public function testTextValuesAreSanitized(): void
    {
        $config = FileServeConfig::normalize(['1' => ['adapter' => 'platform', 'url' => ' <b>https://x</b> ']]);
        self::assertNotInstanceOf(WP_Error::class, $config);
        self::assertSame('https://x', $config['1']['url']);
    }

    public function testCorruptInputRefusesTheSave(): void
    {
        self::assertInstanceOf(WP_Error::class, FileServeConfig::normalize('not json'));
        self::assertInstanceOf(WP_Error::class, FileServeConfig::normalize('null'));
        self::assertInstanceOf(WP_Error::class, FileServeConfig::normalize(['1' => 'not a group']));
    }

    public function testEmptyConfigEncodesToAnEmptyString(): void
    {
        self::assertSame('', FileServeConfig::encode([]));
    }

    public function testNonEmptyConfigEncodesToOneJsonString(): void
    {
        $config = FileServeConfig::normalize(['1' => ['adapter' => 'platform', 'url' => 'https://x']]);
        self::assertNotInstanceOf(WP_Error::class, $config);
        $json = FileServeConfig::encode($config);
        self::assertStringContainsString('"1"', $json);
        self::assertStringContainsString('"platform"', $json);
        self::assertSame($config, json_decode($json, true));
    }

    public function testCanonicalIgnoresGroupOrder(): void
    {
        $a = FileServeConfig::normalize([
            '1' => ['adapter' => 'platform', 'url' => 'https://x'],
            '2' => ['adapter' => 'gofile_api', 'folder_id' => 'abc'],
        ]);
        $b = FileServeConfig::normalize([
            '2' => ['adapter' => 'gofile_api', 'folder_id' => 'abc'],
            '1' => ['adapter' => 'platform', 'url' => 'https://x'],
        ]);
        self::assertNotInstanceOf(WP_Error::class, $a);
        self::assertNotInstanceOf(WP_Error::class, $b);
        self::assertSame(FileServeConfig::canonical($a), FileServeConfig::canonical($b));
    }

    public function testCanonicalDistinguishesRealChanges(): void
    {
        $a = FileServeConfig::normalize(['1' => ['adapter' => 'platform', 'url' => 'https://x']]);
        $b = FileServeConfig::normalize(['1' => ['adapter' => 'platform', 'url' => 'https://y']]);
        self::assertNotInstanceOf(WP_Error::class, $a);
        self::assertNotInstanceOf(WP_Error::class, $b);
        self::assertNotSame(FileServeConfig::canonical($a), FileServeConfig::canonical($b));
    }

    public function testPresentReadsTheStoredJsonString(): void
    {
        self::assertNull(FileServeConfig::present(100));

        update_post_meta(100, FileServeConfig::META_KEY, '{"1":{"adapter":"platform","url":"https://x"}}');
        $presented = FileServeConfig::present(100);
        self::assertIsArray($presented);
        self::assertSame('platform', $presented['1']['adapter']);
    }

    public function testPresentReadsAHandWrittenDecodedMeta(): void
    {
        update_post_meta(100, FileServeConfig::META_KEY, ['1' => ['adapter' => 'platform']]);
        self::assertIsArray(FileServeConfig::present(100));

        update_post_meta(100, FileServeConfig::META_KEY, []);
        self::assertNull(FileServeConfig::present(100));
    }
}
