// Live smoke test of the GitHub API client against real notes on git/git.
// Usage: node scripts/live-test-api.mjs   (network required; unauthenticated)
// Bundles src/lib/github-api.ts for Node first, then exercises the full
// pipeline: discover refs -> resolve tree + fanout -> fetch a known note.
import { execFileSync } from 'node:child_process'
import assert from 'node:assert'

execFileSync('node_modules/.bin/esbuild', [
  'src/lib/github-api.ts',
  '--bundle',
  '--format=esm',
  '--platform=neutral',
  '--outfile=scripts/.github-api.bundle.mjs',
])

const api = await import('./.github-api.bundle.mjs')

const refs = await api.discoverNotesRefs('git', 'git')
console.log('refs:', refs)
assert(refs.some((r) => r.ref === 'refs/notes/amlog'), 'expected refs/notes/amlog')

const amlog = refs.find((r) => r.ref === 'refs/notes/amlog')
const tree = await api.resolveNotesTree('git', 'git', amlog.tipSha)
console.log('tree:', tree)
assert.deepEqual(tree.fanouts, [2], 'git/git amlog uses uniform 2-level fanout')

const sha = '000023961a0c02d6e21dc51ea3484ff71abf1c74'
const note = await api.fetchNote('git', 'git', 'refs/notes/amlog', tree.fanouts, sha)
console.log('note:', note)
assert(note && note.content.includes('Message-Id:'), 'expected the known amlog note')

const none = await api.fetchNote(
  'git',
  'git',
  'refs/notes/amlog',
  tree.fanouts,
  'ffffffffffffffffffffffffffffffffffffffff'
)
assert.equal(none, null, 'nonexistent note must be null')

const expanded = await api.expandSha('git', 'git', '000023961a')
assert.equal(expanded, sha, 'short sha expansion')

console.log('\nlive API test: ALL PASS')
