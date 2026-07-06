// Plain-Node test for src/lib/envelope.ts (no framework).
// Invoked as `npm run test:envelope` or directly: `node test/envelope.test.mjs`.
// It bundles the TypeScript with esbuild first, then imports the bundle.

import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

execFileSync(
  path.join(repoRoot, 'node_modules', '.bin', 'esbuild'),
  [
    'src/lib/envelope.ts',
    '--bundle',
    '--format=esm',
    '--outfile=test/.envelope.bundle.mjs',
  ],
  { cwd: repoRoot, stdio: 'inherit' },
)

const { parseNote, noteTitle } = await import('./.envelope.bundle.mjs')

let passed = 0
function test(name, fn) {
  fn()
  passed++
  console.log(`ok - ${name}`)
}

test('valid html envelope', () => {
  const raw = JSON.stringify({ title: 'Perf', gitnotes: 1, type: 'html', body: '<h1>hi</h1>' })
  const p = parseNote(raw)
  assert.deepEqual(p, {
    kind: 'typed',
    envelope: { gitnotes: 1, type: 'html', body: '<h1>hi</h1>', title: 'Perf' },
  })
  assert.equal(noteTitle(p), 'Perf')
})

test('valid markdown envelope', () => {
  const p = parseNote('{"gitnotes": 1, "type": "markdown", "body": "# Hello"}')
  assert.equal(p.kind, 'typed')
  assert.equal(p.envelope.type, 'markdown')
  assert.equal(p.envelope.body, '# Hello')
  assert.equal(p.envelope.title, undefined)
  assert.equal(noteTitle(p), undefined)
})

test('missing type defaults to html', () => {
  const p = parseNote('{"gitnotes": 1, "body": "x"}')
  assert.equal(p.kind, 'typed')
  assert.equal(p.envelope.type, 'html')
})

test('non-string title is dropped', () => {
  const p = parseNote('{"gitnotes": 1, "type": "text", "title": 42, "body": "x"}')
  assert.equal(p.kind, 'typed')
  assert.equal('title' in p.envelope, false)
})

test('leading/trailing whitespace around a valid envelope is fine', () => {
  const p = parseNote('  \n {"gitnotes": 1, "body": "x"} \n ')
  assert.equal(p.kind, 'typed')
})

test('bare text falls back to text', () => {
  const p = parseNote('Just a plain note about a commit.')
  assert.deepEqual(p, { kind: 'text', content: 'Just a plain note about a commit.' })
})

test('malformed JSON falls back with original untrimmed content', () => {
  const raw = '  {"gitnotes": 1, "body": '
  assert.deepEqual(parseNote(raw), { kind: 'text', content: raw })
})

test('JSON array falls back to text', () => {
  assert.deepEqual(parseNote('[1, 2, 3]'), { kind: 'text', content: '[1, 2, 3]' })
})

test('JSON object without gitnotes falls back to text', () => {
  const raw = '{"type": "html", "body": "x"}'
  assert.deepEqual(parseNote(raw), { kind: 'text', content: raw })
})

test('non-numeric gitnotes falls back to text', () => {
  const raw = '{"gitnotes": "1", "body": "x"}'
  assert.deepEqual(parseNote(raw), { kind: 'text', content: raw })
})

test('JSON envelope without body falls back to text', () => {
  const raw = '{"gitnotes": 1, "type": "html"}'
  assert.deepEqual(parseNote(raw), { kind: 'text', content: raw })
})

test('non-string type falls back to text', () => {
  const raw = '{"gitnotes": 1, "type": 7, "body": "x"}'
  assert.deepEqual(parseNote(raw), { kind: 'text', content: raw })
})

test('empty string falls back to text', () => {
  assert.deepEqual(parseNote(''), { kind: 'text', content: '' })
})

test('multibyte content round-trips', () => {
  const body = '日本語のノート — émojis 🎉 and ünïcödé'
  const p = parseNote(JSON.stringify({ gitnotes: 1, type: 'text', body }))
  assert.equal(p.kind, 'typed')
  assert.equal(p.envelope.body, body)
  const bare = 'ただのテキスト 🚀'
  assert.deepEqual(parseNote(bare), { kind: 'text', content: bare })
})

console.log(`\n${passed} tests passed`)
