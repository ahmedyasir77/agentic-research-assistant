/**
 * Whether this instance wants traffic.
 *
 * Liveness and readiness answer different questions and a load balancer treats
 * them differently: a process that is draining is still alive — killing it would
 * abandon the runs it is finishing — but it must stop being sent new work. This
 * flag is the difference, and it is why `/readyz` starts failing the moment
 * SIGTERM arrives rather than when the process finally exits.
 */
export class Lifecycle {
  #draining = false;

  get accepting(): boolean {
    return !this.#draining;
  }

  beginDraining(): void {
    this.#draining = true;
  }
}
