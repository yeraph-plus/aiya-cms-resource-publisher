<?php

declare(strict_types=1);

namespace Aiya\Publish\Tests\Unit;

use Aiya\Publish\Rest\Auth;
use PHPUnit\Framework\Attributes\Before;
use PHPUnit\Framework\TestCase;
use WP_Error;

/**
 * The route gate every endpoint of the plugin shares.
 *
 * This is the suite that has to stay honest about the floor: the publishing
 * tool is an editorial surface, so an account below editor must be refused
 * before any handler runs — not per object, because the list route exposes the
 * whole library. Anonymous 401, below-editor 403, editor and up pass.
 */
final class AuthTest extends TestCase
{
    #[Before]
    public function reset(): void
    {
        aiya_publish_test_reset();
    }

    public function testAnonymousIsRefusedWith401(): void
    {
        $GLOBALS['__test']['userId'] = 0;

        $refused = Auth::require(Auth::EDITOR);

        self::assertInstanceOf(WP_Error::class, $refused);
        self::assertSame('aiya_publish_unauthorized', array_key_first($refused->errors));
        self::assertSame(401, $refused->get_error_data()['status']);
    }

    public function testContributorIsRefusedWith403(): void
    {
        // A contributor: may author posts of their own, may not touch anyone
        // else's — exactly the account that used to read drafts by id.
        $GLOBALS['__test']['caps'] = ['edit_posts', 'publish_posts'];

        $refused = Auth::require(Auth::EDITOR);

        self::assertInstanceOf(WP_Error::class, $refused);
        self::assertSame('aiya_publish_forbidden', array_key_first($refused->errors));
        self::assertSame(403, $refused->get_error_data()['status']);
    }

    public function testAuthorIsRefusedWith403(): void
    {
        $GLOBALS['__test']['caps'] = ['edit_posts', 'edit_published_posts', 'publish_posts', 'upload_files', 'delete_posts'];

        $refused = Auth::require(Auth::EDITOR);

        self::assertInstanceOf(WP_Error::class, $refused);
        self::assertSame(403, $refused->get_error_data()['status']);
    }

    public function testEditorPasses(): void
    {
        $GLOBALS['__test']['caps'] = ['edit_posts', 'edit_others_posts', 'publish_posts', 'read_private_posts', 'upload_files'];

        self::assertTrue(Auth::require(Auth::EDITOR));
    }

    public function testTheFloorIsNotTheSameAsThePerObjectCapability(): void
    {
        // Guards against a future "simplification" back to edit_posts: the two
        // are different strings and the gate must not accept the lower one.
        self::assertNotSame('edit_posts', Auth::EDITOR);
    }

    public function testEveryRequestedCapabilityIsRequired(): void
    {
        $GLOBALS['__test']['caps'] = ['edit_others_posts'];

        self::assertTrue(Auth::require(Auth::EDITOR));

        $refused = Auth::require(Auth::EDITOR, 'upload_files');
        self::assertInstanceOf(WP_Error::class, $refused);
        self::assertSame(403, $refused->get_error_data()['status']);
    }
}
