import {Head, Html, Main, NextScript} from 'next/document';

import {UNREGISTER_BOOT_SCRIPT} from '@/lib/pwa';
import {THEME_BOOT_SCRIPT} from '@/lib/theme';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <meta charSet="utf-8" />
        {/* Google Translate rewrites the DOM under React's feet: https://github.com/facebook/react/issues/11538 */}
        <meta content="notranslate" name="google" />
        <meta content="#1e66f5" name="theme-color" />
        <link href="/manifest.webmanifest" rel="manifest" />
        <link href="/icon.svg" rel="icon" type="image/svg+xml" />
        {/* Applies the saved or system theme before first paint; see lib/theme.ts. */}
        <script dangerouslySetInnerHTML={{__html: THEME_BOOT_SCRIPT}} />
        {/* A production run leaves a service worker on this origin; it must not serve the dev server. */}
        {process.env.NODE_ENV !== 'production' ? (
          <script dangerouslySetInnerHTML={{__html: UNREGISTER_BOOT_SCRIPT}} />
        ) : null}
      </Head>
      <body className="bg-base text-text">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
