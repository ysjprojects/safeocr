import {type FC, memo, useMemo} from 'react';
import Markdown, {type Options} from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, {defaultSchema} from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import type {Mode} from '@/lib/protocol';

/**
 * GLM-OCR writes GitHub-flavoured Markdown with `$…$` / `$$…$$` formulas and raw HTML tables. The
 * HTML is sanitised before it is rendered (the text in a document is untrusted input), and nothing in
 * it may load a remote resource: images are dropped, so an OCR'd page never makes a network request.
 */
const schema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter(tag => tag !== 'img' && tag !== 'picture' && tag !== 'source'),
  attributes: {
    ...defaultSchema.attributes,
    // remark-math marks formulas with these classes; rehype-katex looks for them after sanitising.
    code: [...(defaultSchema.attributes?.code ?? []), ['className', 'language-math', 'math-inline', 'math-display']],
  },
};

const remarkPlugins: Options['remarkPlugins'] = [remarkGfm, remarkMath];
const rehypePlugins: Options['rehypePlugins'] = [rehypeRaw, [rehypeSanitize, schema], rehypeKatex];

interface Props {
  text: string;
  mode: Mode;
}

/**
 * Display-only touch-ups for GLM-OCR's dialect (the stored text stays exactly as generated):
 * a line that is just `$$…$$` is meant as display math (remark-math reads one-line `$$` as inline),
 * and `•` bullets are lists.
 */
export function forDisplay(text: string, mode: Mode): string {
  if (mode === 'formula') return /^\s*(\$\$|\\\[)/.test(text) ? text : `$$\n${text}\n$$`;
  return text.replace(/^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$/gm, '$$$$\n$1\n$$$$').replace(/^([ \t]*)[•●▪]\s+/gm, '$1- ');
}

const OcrMarkdown: FC<Props> = memo(({text, mode}) => {
  const source = useMemo(() => forDisplay(text, mode), [text, mode]);
  return (
    <div className="safeocr-prose prose prose-sm prose-invert max-w-none break-words">
      <Markdown rehypePlugins={rehypePlugins} remarkPlugins={remarkPlugins}>
        {source}
      </Markdown>
    </div>
  );
});
OcrMarkdown.displayName = 'OcrMarkdown';

export default OcrMarkdown;
