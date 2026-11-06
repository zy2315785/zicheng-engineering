/** Lightweight query-time BM25 ranking over text chunks (no embeddings required). */
export function rankChunksBM25(index, directTerms = [], expandedTerms = [], limit = 8) {
  const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().trim();
  const terms = [], used = new Set();
  for (const [values, weight, cap] of [[directTerms, 1, 28], [expandedTerms, 0.35, 12]]) {
    if (!Array.isArray(values)) continue;
    let added = 0;
    for (const raw of values) {
      const value = normalize(raw);
      if (value.length < 2 || value.length > 80 || used.has(value)) continue;
      used.add(value);
      terms.push({ value, weight });
      if (++added >= cap) break;
    }
  }
  if (!terms.length) return [];
  const df = new Uint32Array(terms.length), rows = [];
  let totalBlocks = 0, totalLength = 0;
  for (const doc of index?.docs ?? []) {
    const title = normalize(doc.name) + ' ' + normalize(doc.path);
    for (const chunk of doc.chunks ?? []) {
      const body = normalize(chunk.text);
      if (!body) continue;
      const length = body.length;
      totalBlocks++;
      totalLength += length;
      const tf = new Uint8Array(terms.length);
      let matched = false;
      for (let i = 0; i < terms.length; i++) {
        const token = terms[i].value;
        let from = 0, count = 0;
        while (count < 5) {
          const at = body.indexOf(token, from);
          if (at < 0) break;
          count++;
          from = at + token.length;
        }
        tf[i] = count;
        if (count) { df[i]++; matched = true; }
        else if (title.includes(token)) matched = true;
      }
      if (matched) rows.push({ doc, chunk, title, length, tf });
    }
  }
  if (!totalBlocks) return [];
  const avgLength = Math.max(1, totalLength / totalBlocks);
  const idfs = terms.map((_, i) => Math.log(1 + (totalBlocks - df[i] + 0.5) / (df[i] + 0.5)));
  const scored = [];
  for (const row of rows) {
    const lengthFactor = 1.2 * (0.35 + 0.65 * row.length / avgLength);
    let score = 0;
    for (let i = 0; i < terms.length; i++) {
      const { value, weight } = terms[i], tf = row.tf[i];
      if (tf) score += weight * idfs[i] * (tf * 2.2 / (tf + lengthFactor));
      if (row.title.includes(value)) score += weight * idfs[i] * 2.8;
    }
    if (score > 0) scored.push({ doc: row.doc, chunk: row.chunk, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const usage = new Map(), results = [];
  for (const hit of scored) {
    const id = hit.doc.mediaId || hit.doc.path || hit.doc.name;
    const count = usage.get(id) || 0;
    if (count >= 2) continue;
    usage.set(id, count + 1);
    results.push(hit);
    if (results.length >= Math.max(1, Math.min(40, limit))) break;
  }
  return results;
}
