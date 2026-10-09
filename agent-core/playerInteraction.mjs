// Simulation of player interaction: NPCs react to player chat and propose trades
export function processPlayerChat(agentId, playerName, text, memory) {
  const agent = memory.data.agents[agentId];
  if (!agent) return null;
  const lower = text.toLowerCase();
  if (lower.includes('trade') || lower.includes('buy') || lower.includes('sell')) {
    return { type: 'propose_trade', reply: `${playerName}, I can offer fish for bread. Want to trade?` };
  }
  if (lower.includes('hello') || lower.includes('hi')) {
    return { type: 'greet', reply: `Hello ${playerName}, I'm ${agentId}.` };
  }
  // log interaction
  return { type: 'acknowledge', reply: `Noted, ${playerName}.` };
}
