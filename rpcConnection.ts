import { Connection } from "@solana/web3.js";
import { config } from "../config/index.js";
import { childLogger } from "./logger.js";

const log = childLogger("rpcPool");

/**
 * Round-robin pool over multiple RPC endpoints with automatic fallback.
 * Public RPC endpoints throttle aggressively and occasionally drop
 * requests — for a bot that must never silently stall, every "real" call
 * should go through `withRetry`, which walks the endpoint list on failure
 * instead of hammering a single dead/rate-limited node.
 */
class RpcPool {
  private connections: Connection[];
  private cursor = 0;

  constructor(urls: string[]) {
    if (urls.length === 0) {
      throw new Error("SOLANA_RPC_URLS must contain at least one endpoint");
    }
    this.connections = urls.map((url) => new Connection(url, "confirmed"));
  }

  /** Next connection in the rotation (cheap, no health check). */
  next(): Connection {
    const conn = this.connections[this.cursor % this.connections.length]!;
    this.cursor++;
    return conn;
  }

  get primary(): Connection {
    return this.connections[0]!;
  }

  get all(): Connection[] {
    return this.connections;
  }

  /**
   * Runs `fn` against each connection in turn (starting from the next one
   * in rotation) until one succeeds, with exponential backoff between full
   * sweeps. Throws the last error if every attempt across every sweep fails.
   */
  async withRetry<T>(
    fn: (connection: Connection) => Promise<T>,
    opts: { maxSweeps?: number; baseDelayMs?: number; label?: string } = {}
  ): Promise<T> {
    const maxSweeps = opts.maxSweeps ?? 3;
    const baseDelayMs = opts.baseDelayMs ?? 400;
    let lastError: unknown;

    for (let sweep = 0; sweep < maxSweeps; sweep++) {
      for (let i = 0; i < this.connections.length; i++) {
        const conn = this.next();
        try {
          return await fn(conn);
        } catch (err) {
          lastError = err;
          log.warn(
            { err: (err as Error).message, endpoint: conn.rpcEndpoint, label: opts.label },
            "RPC call failed, trying next endpoint"
          );
        }
      }
      const delay = baseDelayMs * 2 ** sweep;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    log.error({ label: opts.label }, "RPC call failed on all endpoints after all retries");
    throw lastError;
  }
}

export const rpcPool = new RpcPool(config.solana.rpcUrls);
