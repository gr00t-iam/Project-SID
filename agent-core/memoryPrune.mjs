// Memory pruning & summarisation with importance scoring
export function scoreEpisode(ep, now = Date.now()) {
  const ageHours = (now - ep.t) / 3600000;
  const recency = Math.exp(-ageHours / 72); // half-life ~50h
  const salience = ep.salience ?? 0.5;
  const social = ep.who?.length ? 0.3 : 0;
  const emotion = Math.abs(ep.valence ?? 0) * 0.2;
  return 0.5 * salience + 0.3 * recency + social + emotion;
}

export function pruneMemories(memories, cap = 60) {
  if (memories.length <= cap) return memories;
  const now = Date.now();
  const scored = memories.map(m => ({ m, score: scoreEpisode(m, now) }));
  scored.sort((a,b)=> b.score - a.score);
  return scored.slice(0, cap).map(s => s.m);
}

export function summarizeMemories(memories, windowMs = 86400000) {
  const now = Date.now();
  const recent = memories.filter(m => now - m.t <= windowMs);
  const themes = {};
  for (const m of recent) {
    for (const tag of m.tags ?? []) {
      themes[tag] = (themes[tag] ?? 0) + 1;
    }
  }
  const topTags = Object.entries(themes).sort((a,b)=> b[1]-a[1]).slice(0,3).map(([k])=>k);
  return { count: recent.length, topTags, summary: `Recent focus on ${topTags.join(', ') || 'general activity'}` };
}
