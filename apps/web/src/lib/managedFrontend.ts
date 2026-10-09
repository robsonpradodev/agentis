/**
 * Assemble a managed frontend for the sandboxed srcdoc preview.
 *
 * The runtime bridge must be injected while the document is still only HTML.
 * Inlining JavaScript first is unsafe because a dependency may legitimately
 * contain the text `</head>` inside a string (SheetJS does), which would make a
 * later string replacement inject the bridge in the middle of that bundle.
 */
export function assembleManagedFrontendSrcDoc(
  html: string,
  assets: ReadonlyMap<string, string>,
  bridge: string,
): string {
  const headClose = /<\/head\s*>/i;
  if (!headClose.test(html)) {
    throw new Error('Managed frontend index.html must contain a closing head tag');
  }

  let assembled = html.replace(headClose, `${bridge}</head>`);
  assembled = assembled.replace(
    /<link\b[^>]*href=["']\.\/([^"'?#]+\.css)["'][^>]*>/gi,
    (_tag, assetPath: string) =>
      `<style>${neutralizeEmbeddedClose(assets.get(assetPath) ?? '', 'style')}</style>`,
  );
  assembled = assembled.replace(
    /<script\b[^>]*src=["']\.\/([^"'?#]+\.js)["'][^>]*><\/script>/gi,
    (_tag, assetPath: string) =>
      `<script type="module">${neutralizeEmbeddedClose(assets.get(assetPath) ?? '', 'script')}</script>`,
  );
  return assembled;
}

export function neutralizeEmbeddedClose(value: string, tag: 'script' | 'style'): string {
  return value
    .replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`)
    .replace(/^\/\/# sourceMappingURL=.*$/gm, '');
}
