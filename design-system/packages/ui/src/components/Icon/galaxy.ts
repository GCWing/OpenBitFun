/**
 * Lucide galaxy, absent from the currently bundled lucide-react 0.560.
 * Source: https://github.com/lucide-icons/lucide/blob/1.35.0/icons/galaxy.svg
 * Replace with the package export when the shared Lucide dependency is upgraded.
 *
 * ISC License
 * Copyright (c) 2026 Lucide Icons and Contributors
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
import { createLucideIcon } from 'lucide-react';

export const Galaxy = createLucideIcon('Galaxy', [
  ['path', { d: 'M16.005 15.108a5.041 6.52 28.25 00-8.008-6.217 5.041 6.52 28.25 008.008 6.217A11.884 7.288-60.76 014.029 7.001', key: 'spiral-outer' }],
  ['path', { d: 'M17 21h.01', key: 'star-bottom' }],
  ['path', { d: 'M7 3h.01', key: 'star-top' }],
  ['path', { d: 'M7.997 8.891a11.885 7.288-60.756 0111.977 8.107', key: 'spiral-inner' }],
  ['circle', { cx: '12', cy: '12', r: '1', fill: 'currentColor', key: 'core' }],
]);
