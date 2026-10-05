import dynamic from 'next/dynamic';
import Head from 'next/head';
import {type FC, memo} from 'react';

const TITLE = 'SafeOCR — OCR that never leaves your browser';
const DESCRIPTION =
  'SafeOCR: private, in-browser OCR for images and PDFs. GLM-OCR runs on your GPU through WebGPU and returns Markdown, HTML tables and LaTeX formulas; PP-OCRv5 runs anywhere for fast, faithful plain text. Single files or whole batches, nothing uploaded.';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

const loading = () => (
  <div className="bg-plum-900 text-plum-200 flex h-dvh items-center justify-center">
    <span className="animate-pulse text-sm">loading SafeOCR…</span>
  </div>
);

// WebGPU, workers and the browser cache are browser-only; the app never renders on the server.
// eslint-disable-next-line react-memo/require-memo
const SafeOcrApp = dynamic(() => import('@/components/SafeOcrApp'), {loading, ssr: false});

const Page: FC = memo(() => (
  <>
    <Head>
      <title>{TITLE}</title>
      <meta content={DESCRIPTION} name="description" />
      {SITE_URL !== undefined ? <link href={`${SITE_URL}/`} key="canonical" rel="canonical" /> : null}
      <meta content={TITLE} property="og:title" />
      <meta content={DESCRIPTION} property="og:description" />
      {SITE_URL !== undefined ? <meta content={`${SITE_URL}/`} property="og:url" /> : null}
      <meta content={TITLE} name="twitter:title" />
      <meta content={DESCRIPTION} name="twitter:description" />
      <meta content="width=device-width, initial-scale=1" name="viewport" />
    </Head>
    <SafeOcrApp />
  </>
));
Page.displayName = 'Page';

export default Page;
