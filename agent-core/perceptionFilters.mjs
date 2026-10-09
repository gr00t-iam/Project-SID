// Role-based perception filters
export const roleFilters = {
  fisher: (entities) => entities.filter(e => e.type === 'WATER' || e.type === 'FISH' || e.type === 'BOAT'),
  miner: (entities) => entities.filter(e => /STONE|ORE|COAL|IRON|GOLD|REDSTONE|DIAMOND/.test(e.type)),
  lumberjack: (entities) => entities.filter(e => /LOG|LEAVES|WOOD/.test(e.type)),
  default: (entities) => entities,
};

export function filterPerception(role, snapshot) {
  const filter = roleFilters[role] || roleFilters.default;
  const filteredEntities = filter(snapshot.entities ?? []);
  return {
    ...snapshot,
    entities: filteredEntities,
    // also filter blocks if needed
  };
}
