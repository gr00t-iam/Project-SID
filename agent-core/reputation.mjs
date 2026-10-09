// Reputation system influencing LLM personality prompts
export class Reputation {
  constructor() {
    this.scores = new Map(); // agentId -> Map(otherId -> score)
  }
  get(agentId, otherId) {
    return this.scores.get(agentId)?.get(otherId) ?? 0;
  }
  update(agentId, otherId, delta) {
    if (!this.scores.has(agentId)) this.scores.set(agentId, new Map());
    const map = this.scores.get(agentId);
    const cur = map.get(otherId) ?? 0;
    map.set(otherId, Math.max(-100, Math.min(100, cur + delta)));
  }
  promptBias(agentId) {
    const map = this.scores.get(agentId);
    if (!map) return '';
    const avg = [...map.values()].reduce((a,b)=>a+b,0) / map.size;
    if (avg > 20) return 'You are generally trusted by others.';
    if (avg < -20) return 'Others are wary of you.';
    return 'You have neutral standing.';
  }
}
export const reputation = new Reputation();
