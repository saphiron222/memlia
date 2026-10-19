// SPDX-License-Identifier: Apache-2.0
// Tokenization extracted from Sim copy-references.ts, source c6cef5f87b6a1d1d01df89e7140bad9e9fd4c2e2.
const FILE_REFERENCE_RE =
  /(^|[\s("'<>`])((?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|\/\/|sim:file\/|\/(?:api\/(?:files\/(?:view|serve)\/|projects\/)|workspace\/|projects\/))[^\s)"'<>`]+)/g

function absoluteReferenceEnd(content: string, start: number): number {
  let parentheses = 0
  let end = start
  for (; end < content.length; end++) {
    const character = content[end]
    if (/[\s"'<>`]/.test(character)) break
    if (character === '(') parentheses++
    if (character === ')') {
      if (parentheses === 0) break
      parentheses--
    }
  }
  return end
}

/** Enumerates local reference tokens while protecting whole foreign absolute URLs. */
export function* iterateLocalFileReferenceTokens(content: string) {
  let protectedEnd = 0
  for (const match of content.matchAll(FILE_REFERENCE_RE)) {
    const reference = match[2]
    const start = match.index + match[1].length
    if (start < protectedEnd) continue
    if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|\/\/)/.test(reference)) {
      protectedEnd = absoluteReferenceEnd(content, start)
      continue
    }
    yield { reference, start, end: start + reference.length }
  }
}
