// Pathfinding constraints: avoid hostile mobs, respect claims
export function isHostile(type) {
  return /ZOMBIE|CREEPER|SKELETON|SPIDER|ENDERMAN|WITCH|HUSK|DROWNED/.test(type);
}

export function filterPathNodes(nodes, snapshot) {
  const hostilePositions = new Set();
  for (const e of snapshot.entities ?? []) {
    if (isHostile(e.type)) {
      hostilePositions.add(`${Math.round(e.x)},${Math.round(e.z)}`);
    }
  }
  // Remove nodes within 3 blocks of hostile
  return nodes.filter(n => {
    for (const hp of hostilePositions) {
      const [hx,hz] = hp.split(',').map(Number);
      if (Math.hypot(n.x - hx, n.z - hz) < 3) return false;
    }
    // respect claims if claim data present
    if (snapshot.claims) {
      // placeholder: skip nodes inside claimed areas without permission
    }
    return true;
  });
}
