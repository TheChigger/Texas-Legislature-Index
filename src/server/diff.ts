import type { DiffLine } from '../types.ts';

/**
 * Deterministic line-level Longest Common Subsequence (LCS) redline diff
 * for comparing historical Texas bill versions and floor amendments.
 */
export function computeLineDiff(oldText: string, newText: string): {
  lines: DiffLine[];
  addedCount: number;
  removedCount: number;
  unchangedCount: number;
} {
  const oldLines = oldText.replace(/\r\n/g, '\n').split('\n');
  const newLines = newText.replace(/\r\n/g, '\n').split('\n');

  let prefixLen = 0;
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  ) {
    prefixLen++;
  }

  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= prefixLen && newEnd >= prefixLen && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const lines: DiffLine[] = [];
  let addedCount = 0;
  let removedCount = 0;
  let unchangedCount = 0;

  for (let p = 0; p < prefixLen; p++) {
    lines.push({
      type: 'unchanged',
      text: oldLines[p],
      oldLine: p + 1,
      newLine: p + 1,
    });
    unchangedCount++;
  }

  const midOld = oldLines.slice(prefixLen, oldEnd + 1);
  const midNew = newLines.slice(prefixLen, newEnd + 1);
  const n = midOld.length;
  const m = midNew.length;

  let oldLineNum = prefixLen + 1;
  let newLineNum = prefixLen + 1;

  if (n * m <= 900_000) {
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (midOld[i] === midNew[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midOld[i] === midNew[j]) {
        lines.push({
          type: 'unchanged',
          text: midOld[i],
          oldLine: oldLineNum++,
          newLine: newLineNum++,
        });
        unchangedCount++;
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        lines.push({
          type: 'removed',
          text: midOld[i],
          oldLine: oldLineNum++,
        });
        removedCount++;
        i++;
      } else {
        lines.push({
          type: 'added',
          text: midNew[j],
          newLine: newLineNum++,
        });
        addedCount++;
        j++;
      }
    }

    while (i < n) {
      lines.push({ type: 'removed', text: midOld[i], oldLine: oldLineNum++ });
      removedCount++;
      i++;
    }
    while (j < m) {
      lines.push({ type: 'added', text: midNew[j], newLine: newLineNum++ });
      addedCount++;
      j++;
    }
  } else {
    // Fast bounded anchor diff for huge untruncated bills (e.g. omnibus / appropriations bills)
    const newIndexMap = new Map<string, number[]>();
    for (let j = 0; j < m; j++) {
      const arr = newIndexMap.get(midNew[j]);
      if (arr) arr.push(j);
      else newIndexMap.set(midNew[j], [j]);
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midOld[i] === midNew[j]) {
        lines.push({ type: 'unchanged', text: midOld[i], oldLine: oldLineNum++, newLine: newLineNum++ });
        unchangedCount++;
        i++;
        j++;
        continue;
      }
      const candidates = newIndexMap.get(midOld[i]);
      const matchJ = candidates?.find((idx) => idx >= j && idx - j <= 120);
      if (matchJ !== undefined) {
        while (j < matchJ) {
          lines.push({ type: 'added', text: midNew[j], newLine: newLineNum++ });
          addedCount++;
          j++;
        }
        lines.push({ type: 'unchanged', text: midOld[i], oldLine: oldLineNum++, newLine: newLineNum++ });
        unchangedCount++;
        i++;
        j++;
      } else {
        lines.push({ type: 'removed', text: midOld[i], oldLine: oldLineNum++ });
        removedCount++;
        i++;
      }
    }
    while (i < n) {
      lines.push({ type: 'removed', text: midOld[i], oldLine: oldLineNum++ });
      removedCount++;
      i++;
    }
    while (j < m) {
      lines.push({ type: 'added', text: midNew[j], newLine: newLineNum++ });
      addedCount++;
      j++;
    }
  }

  for (let s = oldEnd + 1; s < oldLines.length; s++) {
    lines.push({
      type: 'unchanged',
      text: oldLines[s],
      oldLine: oldLineNum++,
      newLine: newLineNum++,
    });
    unchangedCount++;
  }

  return { lines, addedCount, removedCount, unchangedCount };
}
