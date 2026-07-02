// Runs in a worker thread so the UI stays responsive during long scans.
// Builds a size tree of the scanned root. Files under 1 MB are aggregated
// per-directory into a single "(smaller files)" node to keep memory and
// IPC payload bounded even on drives with millions of files.

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');

const SMALL_FILE_LIMIT = 1024 * 1024; // 1 MB
const LARGEST_KEEP = 100;

let files = 0;
let dirs = 0;
let bytes = 0;
let errors = 0;
let lastReport = 0;

// Global top-N largest files: { p: fullPath, s: size, m: mtimeMs }
let largest = [];
let largestMin = 0;

function noteLargest(p, s, m) {
  if (largest.length >= LARGEST_KEEP && s <= largestMin) return;
  largest.push({ p, s, m });
  if (largest.length > LARGEST_KEEP * 2) trimLargest();
}

function trimLargest() {
  largest.sort((a, b) => b.s - a.s);
  if (largest.length > LARGEST_KEEP) largest.length = LARGEST_KEEP;
  largestMin = largest.length ? largest[largest.length - 1].s : 0;
}

function report(current) {
  const now = Date.now();
  if (now - lastReport < 250) return;
  lastReport = now;
  parentPort.postMessage({ type: 'progress', files, dirs, bytes, errors, current });
}

function joinPath(dir, name) {
  return dir.endsWith('\\') ? dir + name : dir + '\\' + name;
}

// Tree node shape (short keys keep the structured-clone payload small):
//   n: name, s: size, d: 1 if directory, f: file count, c: children,
//   m: mtimeMs (files only), agg: 1 for the aggregated small-files node
function scanDir(dirPath, name) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (_) {
    errors++;
    return null;
  }
  dirs++;
  report(dirPath);

  const children = [];
  let size = 0;
  let fileCount = 0;
  let smallSize = 0;
  let smallCount = 0;

  for (const ent of entries) {
    let isDir, isFile;
    try {
      // Skip symlinks and junctions (e.g. "Documents and Settings") to
      // avoid loops and double counting.
      if (ent.isSymbolicLink()) continue;
      isDir = ent.isDirectory();
      isFile = ent.isFile();
    } catch (_) {
      continue;
    }
    const full = joinPath(dirPath, ent.name);

    if (isDir) {
      const child = scanDir(full, ent.name);
      if (child) {
        size += child.s;
        fileCount += child.f;
        children.push(child);
      }
    } else if (isFile) {
      let st;
      try {
        st = fs.lstatSync(full);
      } catch (_) {
        errors++;
        continue;
      }
      files++;
      fileCount++;
      bytes += st.size;
      size += st.size;
      if (st.size >= SMALL_FILE_LIMIT) {
        children.push({ n: ent.name, s: st.size, m: Math.round(st.mtimeMs) });
        noteLargest(full, st.size, Math.round(st.mtimeMs));
      } else {
        smallSize += st.size;
        smallCount++;
      }
    }
  }

  if (smallCount > 0) {
    children.push({ n: `${smallCount.toLocaleString()} smaller files (< 1 MB each)`, s: smallSize, agg: 1 });
  }
  children.sort((a, b) => b.s - a.s);

  return { n: name, s: size, d: 1, f: fileCount, c: children };
}

const rawRoot = workerData.root;
// Normalize: "C:" -> "C:\", strip trailing slash on plain folders
let root = rawRoot;
if (/^[A-Za-z]:$/.test(root)) root += '\\';
if (root.length > 3 && root.endsWith('\\')) root = root.slice(0, -1);

const tree = scanDir(root, root);
trimLargest();

if (tree) {
  parentPort.postMessage({ type: 'done', root, tree, largest, files, dirs, bytes, errors });
} else {
  parentPort.postMessage({ type: 'done', root, tree: null, error: `Could not read ${root}. Try running as administrator.` });
}
