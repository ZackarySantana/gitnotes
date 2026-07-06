// src/lib/github-api.ts
var API_BASE = "https://api.github.com";
var RateLimitError = class extends Error {
  constructor(endpoint) {
    super(`GitHub API rate limit exceeded (${endpoint})`);
    this.name = "RateLimitError";
  }
};
function buildHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}
async function apiGet(path, token) {
  const res = await fetch(`${API_BASE}${path}`, { headers: buildHeaders(token) });
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    throw new RateLimitError(path);
  }
  return res;
}
async function apiGetJson(path, token) {
  const res = await apiGet(path, token);
  if (!res.ok) {
    throw new Error(`GitHub API responded ${res.status} for ${path}`);
  }
  return await res.json();
}
function decodeBase64Utf8(b64) {
  const clean = b64.replace(/\s+/g, "");
  const bytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
var HEX2_RE = /^[0-9a-f]{2}$/;
var FULL_SHA_RE = /^[0-9a-f]{40}$/i;
async function discoverNotesRefs(owner, repo, token) {
  const PER_PAGE = 100;
  const refs = [];
  for (let page = 1; ; page++) {
    const path = `/repos/${owner}/${repo}/git/matching-refs/notes/?per_page=${PER_PAGE}&page=${page}`;
    const res = await apiGet(path, token);
    if (res.status === 404) return refs;
    if (!res.ok) throw new Error(`GitHub API responded ${res.status} for ${path}`);
    const entries = await res.json();
    refs.push(...entries.map((e) => ({ ref: e.ref, tipSha: e.object.sha })));
    if (entries.length < PER_PAGE) return refs;
  }
}
async function getTree(owner, repo, treeSha, token) {
  return apiGetJson(`/repos/${owner}/${repo}/git/trees/${treeSha}`, token);
}
async function resolveNotesTree(owner, repo, tipSha, token) {
  const commit = await apiGetJson(
    `/repos/${owner}/${repo}/git/commits/${tipSha}`,
    token
  );
  const treeSha = commit.tree.sha;
  const top = await getTree(owner, repo, treeSha, token);
  const flatBlobs = top.tree.some((e) => e.type === "blob" && FULL_SHA_RE.test(e.path));
  const firstSubtree = top.tree.find((e) => e.type === "tree" && HEX2_RE.test(e.path));
  const fanouts = [];
  if (firstSubtree) {
    const sub = await getTree(owner, repo, firstSubtree.sha, token);
    const hasSecondLevel = sub.tree.some((e) => e.type === "tree" && HEX2_RE.test(e.path));
    const hasDepth1Blobs = sub.tree.some((e) => e.type === "blob" && e.path.length === 38);
    if (hasSecondLevel) fanouts.push(2);
    if (hasDepth1Blobs) fanouts.push(1);
    if (fanouts.length === 0) fanouts.push(1);
  }
  if (flatBlobs || fanouts.length === 0) fanouts.push(0);
  return { treeSha, fanouts };
}
function fanoutPath(commitSha, fanout) {
  switch (fanout) {
    case 0:
      return commitSha;
    case 1:
      return `${commitSha.slice(0, 2)}/${commitSha.slice(2)}`;
    case 2:
      return `${commitSha.slice(0, 2)}/${commitSha.slice(2, 4)}/${commitSha.slice(4)}`;
  }
}
async function fetchNote(owner, repo, notesRef, fanouts, commitSha, token) {
  const depths = fanouts.length > 0 ? fanouts : [0];
  for (const fanout of depths) {
    const path = `/repos/${owner}/${repo}/contents/${fanoutPath(commitSha, fanout)}?ref=${encodeURIComponent(notesRef)}`;
    const res = await apiGet(path, token);
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`GitHub API responded ${res.status} for ${path}`);
    const data = await res.json();
    return { blobSha: data.sha, content: decodeBase64Utf8(data.content) };
  }
  return null;
}
async function fetchCommitDiff(owner, repo, commitSha, token) {
  const FILE_CAP = 300;
  const data = await apiGetJson(
    `/repos/${owner}/${repo}/commits/${commitSha}`,
    token
  );
  const files = (data.files ?? []).map((f) => {
    const file = {
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions
    };
    if (f.previous_filename !== void 0) file.previousFilename = f.previous_filename;
    if (f.patch !== void 0) file.patch = f.patch;
    return file;
  });
  return { files, truncated: files.length >= FILE_CAP };
}
async function fetchCommitInfo(owner, repo, commitSha, token) {
  const data = await apiGetJson(`/repos/${owner}/${repo}/commits/${commitSha}`, token);
  const subject = data.commit.message.split("\n", 1)[0] ?? "";
  const dateStr = data.commit.committer?.date ?? data.commit.author?.date;
  const committedAt = dateStr ? Date.parse(dateStr) : 0;
  return { subject, committedAt };
}
async function expandSha(owner, repo, shortSha, token) {
  if (FULL_SHA_RE.test(shortSha)) return shortSha;
  const commit = await apiGetJson(
    `/repos/${owner}/${repo}/commits/${shortSha}`,
    token
  );
  return commit.sha;
}
export {
  RateLimitError,
  discoverNotesRefs,
  expandSha,
  fetchCommitDiff,
  fetchCommitInfo,
  fetchNote,
  resolveNotesTree
};
