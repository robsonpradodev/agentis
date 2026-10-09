import { describe, expect, it } from 'vitest';
import { assembleManagedFrontendSrcDoc } from '../src/lib/managedFrontend';

describe('assembleManagedFrontendSrcDoc', () => {
  it('injects the bridge into the document head before bundles are inlined', () => {
    const html = '<html><head><script type="module" src="./assets/app.js"></script></head><body></body></html>';
    const bundle = 'const exportTemplate = "</head><body>Sheet export</body></html>"; window.ready = true;';
    const bridge = '<script>window.agentis = { operations: {} };</script>';

    const assembled = assembleManagedFrontendSrcDoc(
      html,
      new Map([['assets/app.js', bundle]]),
      bridge,
    );

    expect(assembled).toContain(`<script type="module">${bundle}</script>`);
    expect(assembled).toContain(`window.ready = true;</script>${bridge}</head>`);
    expect(assembled.match(/window\.agentis = \{ operations: \{\} \};/g)).toHaveLength(1);
  });

  it('neutralizes closing script and style sequences inside embedded assets', () => {
    const html = '<html><head><link href="./assets/app.css" rel="stylesheet"><script src="./assets/app.js"></script></head><body></body></html>';
    const assembled = assembleManagedFrontendSrcDoc(
      html,
      new Map([
        ['assets/app.js', 'const html = "</script>";'],
        ['assets/app.css', 'x::after { content: "</style>"; }'],
      ]),
      '<script>window.bridge = true;</script>',
    );

    expect(assembled).toContain('<\\/script>');
    expect(assembled).toContain('<\\/style>');
  });

  it('fails clearly when the entry document has no head boundary', () => {
    expect(() => assembleManagedFrontendSrcDoc('<div>invalid</div>', new Map(), '<script/>'))
      .toThrow('closing head tag');
  });
});
