<?php

declare(strict_types=1);

namespace Aiya\Publish\Tests\Unit;

use Aiya\Publish\Rest\TermResolver;
use PHPUnit\Framework\Attributes\Before;
use PHPUnit\Framework\TestCase;
use WP_Error;
use WP_Taxonomy;
use WP_Term;

final class TermResolverTest extends TestCase
{
    #[Before]
    public function reset(): void
    {
        aiya_publish_test_reset();
        $GLOBALS['__test']['taxonomies'] = [
            'resource_category' => new WP_Taxonomy('resource_category', true),
            'resource_original' => new WP_Taxonomy('resource_original', false),
        ];
    }

    public function testAnAbsentTermMapReadsAsNoTerms(): void
    {
        self::assertSame([], TermResolver::resolve(null));
    }

    public function testAMalformedTermMapIsRefused(): void
    {
        self::assertInstanceOf(WP_Error::class, TermResolver::resolve('nope'));
        self::assertInstanceOf(WP_Error::class, TermResolver::resolve(['resource_category' => 'nope']));
        self::assertInstanceOf(WP_Error::class, TermResolver::resolve(['unknown_taxonomy' => [1]]));
        self::assertInstanceOf(WP_Error::class, TermResolver::resolve([123 => [1]]));
    }

    public function testExistingTermIdsPassThrough(): void
    {
        $GLOBALS['__test']['terms'][10] = new WP_Term(10, '分类A', 'cat-a', 'resource_category');

        $resolved = TermResolver::resolve(['resource_category' => [10, '10']]);
        self::assertNotInstanceOf(WP_Error::class, $resolved);
        self::assertSame([10], $resolved['resource_category']);
    }

    public function testAMissingTermIdIsRefused(): void
    {
        $result = TermResolver::resolve(['resource_category' => [99]]);
        self::assertInstanceOf(WP_Error::class, $result);
    }

    public function testAnIdFromAnotherTaxonomyIsRefused(): void
    {
        $GLOBALS['__test']['terms'][10] = new WP_Term(10, '原作A', 'orig-a', 'resource_original');

        self::assertInstanceOf(WP_Error::class, TermResolver::resolve(['resource_category' => [10]]));
    }

    public function testNamesResolveToExistingTerms(): void
    {
        $GLOBALS['__test']['terms'][12] = new WP_Term(12, '原作A', 'orig-a', 'resource_original');

        $resolved = TermResolver::resolve(['resource_original' => [' 原作A ']]);
        self::assertNotInstanceOf(WP_Error::class, $resolved);
        self::assertSame([12], $resolved['resource_original']);
    }

    public function testNewNamesAreCreated(): void
    {
        $resolved = TermResolver::resolve(['resource_original' => ['新原作']]);
        self::assertNotInstanceOf(WP_Error::class, $resolved);
        $id = $resolved['resource_original'][0];
        self::assertGreaterThan(0, $id);
        self::assertSame('新原作', $GLOBALS['__test']['terms'][$id]->name);
    }

    public function testCreatingANewTermNeedsTheCapability(): void
    {
        $GLOBALS['__test']['caps'] = ['assign_terms'];

        $error = TermResolver::resolve(['resource_original' => ['新原作']]);
        self::assertInstanceOf(WP_Error::class, $error);

        // Existing names still assign fine without manage_terms.
        $GLOBALS['__test']['terms'][12] = new WP_Term(12, '原作A', 'orig-a', 'resource_original');
        $resolved = TermResolver::resolve(['resource_original' => ['原作A']]);
        self::assertNotInstanceOf(WP_Error::class, $resolved);
        self::assertSame([12], $resolved['resource_original']);
    }

    public function testDuplicateNamesCollapseToOneId(): void
    {
        $GLOBALS['__test']['terms'][12] = new WP_Term(12, '原作A', 'orig-a', 'resource_original');

        $resolved = TermResolver::resolve(['resource_original' => ['原作A', 12, '原作A']]);
        self::assertNotInstanceOf(WP_Error::class, $resolved);
        self::assertSame([12], $resolved['resource_original']);
    }

    public function testMalformedItemsAreRefused(): void
    {
        self::assertInstanceOf(WP_Error::class, TermResolver::resolve(['resource_original' => ['']]));
        self::assertInstanceOf(WP_Error::class, TermResolver::resolve(['resource_original' => [['nested']]]));
        self::assertInstanceOf(WP_Error::class, TermResolver::resolve(['resource_original' => [-1]]));
    }
}
