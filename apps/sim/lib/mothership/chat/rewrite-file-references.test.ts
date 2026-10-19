import { describe, expect, it } from 'vitest'
import { rewriteMessageFileRefs } from './rewrite-file-references'
import type { PersistedMessage } from './persisted-message'

const maps = {
  fileIds: new Map([['old', 'new']]),
  fileKeys: new Map([['folder/a b.png', 'copy/b.png']]),
  workspaceId: 'ws',
}
const message = (content: string) => ({ content }) as PersistedMessage
describe('copied chat file references', () => {
  it('rewrites supported links without changing adjacent text or suffixes', () => {
    const text =
      'old [x](/api/files/view/old?v=2#page) sim:file/old /workspace/ws/files/old /api/files/serve/folder%2Fa%20b.png?context=mothership'
    expect(rewriteMessageFileRefs([message(text)], maps)[0].content).toBe(
      'old [x](/api/files/view/new?v=2#page) sim:file/new /workspace/ws/files/new /api/files/serve/copy%2Fb.png?context=mothership'
    )
  })
  it('leaves other ids, workspaces and malformed encodings unchanged', () => {
    const text =
      '/api/files/view/oldish /workspace/other/files/old /api/files/serve/%ZZ sim:file/unmapped'
    expect(rewriteMessageFileRefs([message(text)], maps)[0].content).toBe(text)
  })
  it('does not rewrite a foreign absolute URL or a reference inside another token', () => {
    const text =
      'https://foreign.example/api/files/view/old xsim:file/old /other/api/files/view/old'
    expect(rewriteMessageFileRefs([message(text)], maps)[0].content).toBe(text)
  })
  it('rewrites structured tool values and attachment ids without mutating the input', () => {
    const source = {
      content: 'old',
      contentBlocks: [
        { type: 'tool_call', toolCall: { params: { fileId: 'old', nested: ['folder/a b.png'] } } },
      ],
      fileAttachments: [{ id: 'old', key: 'folder/a b.png' }],
      contexts: [{ fileId: 'old' }],
    } as unknown as PersistedMessage
    const result = rewriteMessageFileRefs([source], maps)[0]
    expect(result.fileAttachments?.[0]).toMatchObject({ id: 'new', key: 'copy/b.png' })
    expect(result.contexts?.[0].fileId).toBe('new')
    expect(result.contentBlocks?.[0].toolCall?.params).toEqual({
      fileId: 'new',
      nested: ['copy/b.png'],
    })
    expect(source.fileAttachments?.[0].id).toBe('old')
  })
  it.each([
    {
      name: 's3 storage',
      input: '![image](/api/files/serve/s3/workspace%2Fws%2F123-photo.png?context=mothership)',
      expected: '![image](/api/files/serve/s3/workspace%2Fws%2F456-copy.png?context=mothership)',
    },
    {
      name: 'blob storage',
      input: '![image](/api/files/serve/blob/workspace%2Fws%2F123-photo.png?context=mothership)',
      expected: '![image](/api/files/serve/blob/workspace%2Fws%2F456-copy.png?context=mothership)',
    },
    {
      name: 'gcs storage',
      input: '![image](/api/files/serve/gcs/workspace%2Fws%2F123-photo.png?context=mothership)',
      expected: '![image](/api/files/serve/gcs/workspace%2Fws%2F456-copy.png?context=mothership)',
    },
    {
      name: 'sentence punctuation',
      input: 'See /api/files/view/old.',
      expected: 'See /api/files/view/new.',
    },
    {
      name: 'foreign query',
      input: 'https://foreign.example/?next=/api/files/view/old',
      expected: 'https://foreign.example/?next=/api/files/view/old',
    },
    {
      name: 'foreign path parentheses',
      input: 'https://foreign.example/a(/api/files/view/old)',
      expected: 'https://foreign.example/a(/api/files/view/old)',
    },
  ])('uses native token boundaries for $name', ({ input, expected }) => {
    const scopedMaps = {
      ...maps,
      fileKeys: new Map([['workspace/ws/123-photo.png', 'workspace/ws/456-copy.png']]),
    }
    expect(rewriteMessageFileRefs([message(input)], scopedMaps)[0].content).toBe(expected)
  })
  it('does not remap an explicitly different sim:file owner', () => {
    const input = 'sim:file/old?workspace=other sim:file/old?project=ws'
    expect(rewriteMessageFileRefs([message(input)], maps)[0].content).toBe(input)
  })
})
