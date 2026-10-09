// Emotion model integration with LLM planning bias
export function moodToBias(mood) {
  // mood: {morale, stress}
  const moraleNorm = (mood.morale ?? 50) / 100;
  const stressNorm = (mood.stress ?? 25) / 100;
  return {
    exploration: Math.max(0, moraleNorm - stressNorm * 0.5),
    risk: Math.max(0, moraleNorm * 0.6 - stressNorm * 0.4),
    sociability: moraleNorm * 0.8,
    caution: 0.5 + stressNorm * 0.5,
  };
}

export function injectMoodIntoPrompt(basePrompt, mood) {
  const bias = moodToBias(mood);
  const moodDesc = mood.morale >= 70 ? 'upbeat' : mood.morale >= 40 ? 'steady' : 'low';
  const stressDesc = mood.stress >= 70 ? 'stressed' : mood.stress >= 40 ? 'uneasy' : 'calm';
  return `${basePrompt}

Current emotional state: morale ${mood.morale ?? 50} (${moodDesc}), stress ${mood.stress ?? 25} (${stressDesc}).
Planning bias: exploration ${bias.exploration.toFixed(2)}, risk ${bias.risk.toFixed(2)}, sociability ${bias.sociability.toFixed(2)}, caution ${bias.caution.toFixed(2)}.
Prefer actions consistent with this mood; avoid risky moves when stressed.`;
}
