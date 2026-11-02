# Beautiful UI

Source: https://www.beautifului.dev/ · https://github.com/slev12397/beautiful-ui

Pinned revision: `44a274e598395ab61e7c96c26fda2758780253b7`

Vendored files: `src/vendor/beautiful-ui/foundation.css` (official registry foundation), `Button.tsx`, `SegmentedControl.tsx`, `SearchField.tsx` (extracted from `SearchList.tsx`), `FilterChips.tsx` (extracted from `FilterTable.tsx`).

Adapters: use the existing data-theme attribute and class-name helper; preserve the local Button API through the upstream buttonVariants. SegmentedControl accepts translated labels and uses native radios. SearchField extracts the working search input and clear action without demo results. Application layout, concise page copy and accessible native modal dialogs live outside the vendored styles. Demo motion, thinking indicators, card primitives and paid icons are not imported.

FilterChips accepts real record counts and translated labels, uses aria-pressed, and wraps at narrow widths. Records Table and Filter Table inform the application's compact semantic tables, quiet row hover and explicit detail actions; demo AI calculations and editable property controls are omitted. The upstream loading-state demo is intentionally not included or used; application loading uses a compact content skeleton.

FilterChips also adapts the same upstream selection styling for form section tabs, with tab/panel relationships, roving focus and Arrow/Home/End keyboard navigation. Group editing uses these tabs inside a native modal over the originating list or device detail. Sidebar Nav informs the compact, always-visible navigation groups; its demo search, collapse and motion are omitted.

Application controls adapt the upstream pill treatment to one shared 6px corner token. FilterChips uses a quiet selected fill without an outline or nested count badge; SegmentedControl uses inset corners, and SearchField uses a filled input without an extra separator. The shared Button adapter overrides upstream pill radii without changing button behavior or variants.

MIT License

Copyright (c) 2026 Shane Levine

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
