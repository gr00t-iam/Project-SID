// Multi-agent resource leases: tools, workbenches, fishing spots
export class ResourceLease {
  constructor() {
    this.leases = new Map(); // resourceKey -> {agentId, until}
  }
  acquire(agentId, resourceKey, ttlMs = 60000) {
    const now = Date.now();
    const existing = this.leases.get(resourceKey);
    if (existing && existing.until > now) return false;
    this.leases.set(resourceKey, { agentId, until: now + ttlMs });
    return true;
  }
  release(agentId, resourceKey) {
    const existing = this.leases.get(resourceKey);
    if (existing && existing.agentId === agentId) {
      this.leases.delete(resourceKey);
      return true;
    }
    return false;
  }
  isHeld(agentId, resourceKey) {
    const e = this.leases.get(resourceKey);
    return e && e.agentId === agentId && e.until > Date.now();
  }
  cleanup() {
    const now = Date.now();
    for (const [k,v] of this.leases.entries()) {
      if (v.until <= now) this.leases.delete(k);
    }
  }
}
export const toolsLease = new ResourceLease();
export const workbenchLease = new ResourceLease();
export const fishingSpotLease = new ResourceLease();
