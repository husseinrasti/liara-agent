'use client';

import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

/** Sanitized markdown for assistant text (links open in a new tab; code stays LTR). */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown text-[15px] leading-8 text-slate-800">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" dir="ltr" lang="en" className="font-medium text-blue-700 underline decoration-blue-300 underline-offset-4 hover:text-blue-800">
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code dir="ltr" lang="en" className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[13px] text-slate-700">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre dir="ltr" lang="en" className="my-2 overflow-x-auto rounded-xl bg-slate-900 p-3 text-left text-[13px] leading-6 text-slate-100">
              {children}
            </pre>
          ),
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 ps-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 ps-5">{children}</ol>,
          p: ({ children }) => <p className="my-1.5">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
