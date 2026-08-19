// ── the guard around a lazily-loaded code surface ────────────────────────────
//
// CodeMirror arrives as its own 332 kB chunk, behind `lazy()`, on a link that
// can fail: a deploy that replaced the assets under a long-lived tab, a captive
// portal, a flaky tailnet hop. A failed chunk load is not an exception React can
// recover from on its own, and the default is a blank pane - on a page that may
// be holding unsaved work. This pins the session to the plain `<textarea>` and
// SAYS which of the two the reader is looking at, because "my editor lost its
// line numbers" with no explanation is a bug report.
//
// Lives out here rather than in pages/files/Editor.tsx because it has two
// consumers now - that editor and the theme editor's raw-CSS pane - and
// importing it from Editor.tsx would have pulled the whole Files window into the
// Settings route's chunk to get at a nine-line class.

import { Component } from 'react';

export class CodeBoundary extends Component<
  { children: React.ReactNode; fallback: React.ReactNode; onFail: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch() { this.props.onFail(); }

  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
