// Goal stack with priorities and preemption
export class GoalStack {
  constructor() {
    this.stack = []; // {id, priority, goal, created}
  }
  push(goal, priority = 1) {
    this.stack.push({ id: `${Date.now()}-${Math.random()}`, priority, goal, created: Date.now() });
    this.stack.sort((a,b)=> b.priority - a.priority || a.created - b.created);
  }
  pop() {
    return this.stack.shift();
  }
  peek() {
    return this.stack[0];
  }
  preempt(newGoal, newPriority) {
    const top = this.peek();
    if (!top || newPriority >= top.priority) {
      this.stack = this.stack.filter(g => g.goal !== newGoal.id);
      this.push(newGoal, newPriority);
      return true;
    }
    return false;
  }
  clear() { this.stack = []; }
}
export function selectNextGoal(memoryAgent) {
  // placeholder integration
  return null;
}
