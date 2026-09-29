<?php

declare(strict_types=1);

namespace Aiya\Publish\Tests\Unit;

use Aiya\Publish\Model\FileServeConfig;
use Aiya\Publish\Model\ResourceWriter;
use PHPUnit\Framework\Attributes\Before;
use PHPUnit\Framework\TestCase;
use WP_Error;
use WP_Taxonomy;
use WP_Term;

final class ResourceWriterTest extends TestCase
{
    private const BACKDATED = '2020-01-01 00:00:00';

    #[Before]
    public function reset(): void
    {
        aiya_publish_test_reset();
        $GLOBALS['__test']['taxonomies'] = [
            'resource_category' => new WP_Taxonomy('resource_category', true),
            'resource_original' => new WP_Taxonomy('resource_original', false),
        ];
        $GLOBALS['__test']['terms'][10] = new WP_Term(10, '分类A', 'cat-a', 'resource_category');
    }

    public function testACreateCarriesEveryFieldIntoTheStoredPost(): void
    {
        $created = ResourceWriter::create([
            'title' => '资源标题',
            'content' => '<p>正文</p>',
            'status' => 'publish',
            'date' => self::BACKDATED,
            'authorId' => 2,
            'terms' => ['resource_category' => [10], 'resource_original' => ['原作A']],
            'fileserve' => ['1' => ['adapter' => 'platform', 'url' => 'https://pan.example/s/abc', 'price' => 5]],
        ]);

        self::assertNotInstanceOf(WP_Error::class, $created);
        self::assertSame(100, $created['id']);
        self::assertSame('publish', $created['status']);
        self::assertSame('资源标题', $created['title']);
        self::assertSame('<p>正文</p>', $created['content']);
        self::assertStringStartsWith('2020-01-01T00:00:00', $created['date']);
        self::assertSame(2, $created['authorId']);
        self::assertSame('Author 2', $created['authorName']);
        self::assertSame(10, $created['terms']['resource_category'][0]['id']);
        self::assertSame('原作A', $created['terms']['resource_original'][0]['name']);
        self::assertIsArray($created['fileserve']);
        self::assertSame(5, $created['fileserve']['1']['price']);

        $post = get_post(100);
        self::assertNotNull($post);
        self::assertSame(self::BACKDATED, $post->post_date);
        self::assertSame(2, $post->post_author);

        // The stored meta is the same JSON string the metabox writes.
        $stored = FileServeConfig::present(100);
        self::assertIsArray($stored);
        self::assertSame('platform', $stored['1']['adapter']);
    }

    public function testACreateWithoutDatesUsesTheCurrentMoment(): void
    {
        $created = ResourceWriter::create(['title' => '资源标题']);
        self::assertNotInstanceOf(WP_Error::class, $created);
        self::assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/', $created['date']);
    }

    public function testACreateWithoutFileserveStoresNoMeta(): void
    {
        $created = ResourceWriter::create(['title' => '资源标题', 'fileserve' => null]);
        self::assertNotInstanceOf(WP_Error::class, $created);
        self::assertNull($created['fileserve']);
    }

    public function testPublishingWithoutTheCapabilityIsRefused(): void
    {
        $GLOBALS['__test']['caps'] = ['edit_posts', 'edit_post'];
        $error = ResourceWriter::create(['title' => '资源标题']);
        self::assertInstanceOf(WP_Error::class, $error);
        self::assertSame('aiya_publish_forbidden_publish', array_key_first($error->errors));

        $created = ResourceWriter::create(['title' => '资源标题', 'status' => 'draft']);
        self::assertNotInstanceOf(WP_Error::class, $created);
        self::assertSame('draft', $created['status']);
    }

    public function testAssigningAnotherAuthorOnCreateNeedsTheCapability(): void
    {
        $GLOBALS['__test']['caps'] = ['edit_posts', 'publish_posts'];
        $error = ResourceWriter::create(['title' => '资源标题', 'authorId' => 2]);
        self::assertInstanceOf(WP_Error::class, $error);
        self::assertSame('aiya_publish_forbidden_author', array_key_first($error->errors));
    }

    public function testAMissingTitleIsRefused(): void
    {
        self::assertInstanceOf(WP_Error::class, ResourceWriter::create([]));
        self::assertInstanceOf(WP_Error::class, ResourceWriter::create(['title' => '  ']));
    }

    public function testAFileserveGroupErrorRefusesTheWholeCreate(): void
    {
        $created = ResourceWriter::create([
            'title' => '资源标题',
            'fileserve' => ['1' => ['adapter' => 'nope']],
        ]);
        self::assertInstanceOf(WP_Error::class, $created);
        self::assertNull(get_post(100));
    }

    public function testAnUnknownIdAnswersNotFound(): void
    {
        $error = ResourceWriter::update(999, ['title' => '新标题']);
        self::assertInstanceOf(WP_Error::class, $error);
        self::assertSame('aiya_publish_not_found', array_key_first($error->errors));
    }

    public function testUpdatingWithoutTheEditCapabilityIsRefused(): void
    {
        $created = ResourceWriter::create(['title' => '资源标题', 'date' => self::BACKDATED]);
        self::assertNotInstanceOf(WP_Error::class, $created);

        $GLOBALS['__test']['caps'] = ['edit_posts'];
        $error = ResourceWriter::update(100, ['title' => '新标题']);
        self::assertInstanceOf(WP_Error::class, $error);
        self::assertSame('aiya_publish_forbidden', array_key_first($error->errors));
    }

    public function testAnUpdateOfOneFieldLeavesTheOthersUntouched(): void
    {
        $created = ResourceWriter::create([
            'title' => '资源标题',
            'date' => self::BACKDATED,
            'fileserve' => ['1' => ['adapter' => 'platform', 'url' => 'https://pan.example/s/abc']],
        ]);
        self::assertNotInstanceOf(WP_Error::class, $created);

        $updated = ResourceWriter::update(100, ['title' => '新标题']);
        self::assertNotInstanceOf(WP_Error::class, $updated);
        self::assertSame('新标题', $updated['title']);
        self::assertIsArray($updated['fileserve']);
        self::assertSame('https://pan.example/s/abc', $updated['fileserve']['1']['url']);

        $post = get_post(100);
        self::assertNotNull($post);
        self::assertSame(self::BACKDATED, $post->post_date);
    }

    public function testAChangedFileserveBumpsThePublishMoment(): void
    {
        $created = ResourceWriter::create([
            'title' => '资源标题',
            'date' => self::BACKDATED,
            'fileserve' => ['1' => ['adapter' => 'platform', 'url' => 'https://pan.example/s/abc']],
        ]);
        self::assertNotInstanceOf(WP_Error::class, $created);

        $updated = ResourceWriter::update(100, [
            'fileserve' => ['1' => ['adapter' => 'platform', 'url' => 'https://pan.example/s/new-link']],
        ]);
        self::assertNotInstanceOf(WP_Error::class, $updated);
        self::assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/', $updated['date']);
        self::assertIsArray($updated['fileserve']);
        self::assertSame('https://pan.example/s/new-link', $updated['fileserve']['1']['url']);

        $post = get_post(100);
        self::assertNotNull($post);
        self::assertNotSame(self::BACKDATED, $post->post_date);
    }

    public function testAnUnchangedFileserveDoesNotBump(): void
    {
        $fileserve = ['1' => ['adapter' => 'platform', 'url' => 'https://pan.example/s/abc', 'title' => 'He said "hi"']];
        $created = ResourceWriter::create([
            'title' => '资源标题',
            'date' => self::BACKDATED,
            'fileserve' => $fileserve,
        ]);
        self::assertNotInstanceOf(WP_Error::class, $created);

        // The same configuration, pushed again — quotes included — must
        // survive the meta round-trip without reading as a change.
        $updated = ResourceWriter::update(100, ['fileserve' => $fileserve]);
        self::assertNotInstanceOf(WP_Error::class, $updated);
        self::assertIsArray($updated['fileserve']);
        self::assertSame('He said "hi"', $updated['fileserve']['1']['title']);

        $post = get_post(100);
        self::assertNotNull($post);
        self::assertSame(self::BACKDATED, $post->post_date);
    }

    public function testAnExplicitDateWinsOverTheBump(): void
    {
        $created = ResourceWriter::create([
            'title' => '资源标题',
            'date' => self::BACKDATED,
            'fileserve' => ['1' => ['adapter' => 'platform', 'url' => 'https://pan.example/s/abc']],
        ]);
        self::assertNotInstanceOf(WP_Error::class, $created);

        $updated = ResourceWriter::update(100, [
            'date' => '2021-06-01T12:30',
            'fileserve' => ['1' => ['adapter' => 'platform', 'url' => 'https://pan.example/s/new-link']],
        ]);
        self::assertNotInstanceOf(WP_Error::class, $updated);
        $post = get_post(100);
        self::assertNotNull($post);
        self::assertSame('2021-06-01 12:30:00', $post->post_date);
    }

    public function testAnEmptyFileserveDeletesTheMetaAndBumps(): void
    {
        $created = ResourceWriter::create([
            'title' => '资源标题',
            'date' => self::BACKDATED,
            'fileserve' => ['1' => ['adapter' => 'platform', 'url' => 'https://pan.example/s/abc']],
        ]);
        self::assertNotInstanceOf(WP_Error::class, $created);

        $updated = ResourceWriter::update(100, ['fileserve' => []]);
        self::assertNotInstanceOf(WP_Error::class, $updated);
        self::assertNull($updated['fileserve']);
        $post = get_post(100);
        self::assertNotNull($post);
        self::assertNotSame(self::BACKDATED, $post->post_date);
    }

    public function testTermsAreReplacedPerTaxonomy(): void
    {
        $created = ResourceWriter::create([
            'title' => '资源标题',
            'terms' => ['resource_category' => [10], 'resource_original' => ['原作A']],
        ]);
        self::assertNotInstanceOf(WP_Error::class, $created);

        $updated = ResourceWriter::update(100, ['terms' => ['resource_original' => ['原作B']]]);
        self::assertNotInstanceOf(WP_Error::class, $updated);
        // The untouched taxonomy keeps its terms; the provided one is replaced.
        self::assertSame(10, $updated['terms']['resource_category'][0]['id']);
        self::assertSame('原作B', $updated['terms']['resource_original'][0]['name']);
    }
}
