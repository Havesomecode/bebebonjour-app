import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

import Ajv2020 from "ajv/dist/2020.js";

import {
  claimStageTransition,
  commandReplayDigest,
  completeStageTransition,
  confirmDeliveryTransition,
  createJobAggregate,
  failStageTransition,
  queueDeliveryTransition,
  reconcileDeliveryTransition,
  recordPaymentTransition,
  recordReviewDecisionTransition,
  resumeRetryTransition,
} from "../fulfillment/job-machine.mjs";

const persistenceSchema = JSON.parse(
  await readFile(new URL("../../schemas/fulfillment-job-store.schema.json", import.meta.url), "utf8"),
);
const validatePersistence = new Ajv2020({
  allErrors: true,
  strict: true,
  formats: { "date-time": isCanonicalDateTime },
}).compile(persistenceSchema);

export function createLocalTestFulfillmentStore({ filePath }) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new Error("A local TEST-A fulfillment store filePath is required.");
  }
  const resolvedPath = path.resolve(filePath);
  const mutexPath = `${resolvedPath}.mutex.sqlite`;
  let tail = Promise.resolve();

  function locked(operation) {
    const serialized = () => withFileLock(operation);
    const running = tail.then(serialized, serialized);
    tail = running.catch(() => undefined);
    return running;
  }

  async function withFileLock(operation) {
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    const mutex = new DatabaseSync(mutexPath);
    let acquired = false;
    try {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        try {
          mutex.exec("BEGIN IMMEDIATE");
          acquired = true;
          break;
        } catch (error) {
          if (error?.code !== "ERR_SQLITE_ERROR" || !/database is locked/i.test(error.message)) {
            throw error;
          }
          await delay(10);
        }
      }
      if (!acquired) throw new Error("Timed out acquiring the local fulfillment store lock.");
      try {
        const result = await operation();
        mutex.exec("COMMIT");
        acquired = false;
        return result;
      } catch (error) {
        if (acquired) {
          try {
            mutex.exec("ROLLBACK");
          } catch {
            // Preserve the operation error; closing the connection still releases the OS lock.
          }
        }
        throw error;
      }
    } finally {
      if (acquired) {
        try {
          mutex.exec("ROLLBACK");
        } catch {
          // Closing the connection below is the final lock-release guarantee.
        }
      }
      mutex.close();
    }
  }

  async function readDatabase() {
    try {
      const persisted = normalizePersistentDatabase(JSON.parse(await readFile(resolvedPath, "utf8")));
      assertValidPersistence(persisted);
      const value = fromPersistentDatabase(persisted);
      if (value.schemaVersion !== "1.0" || value.authority !== "local-test-only") {
        throw new Error("Local fulfillment store format or authority marker is invalid.");
      }
      return value;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return {
        schemaVersion: "1.0",
        authority: "local-test-only",
        jobs: {},
      };
    }
  }

  async function writeDatabase(database) {
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    const temporaryPath = `${resolvedPath}.${process.pid}.tmp`;
    const persisted = toPersistentDatabase(database);
    assertValidPersistence(persisted);
    await writeFile(temporaryPath, `${JSON.stringify(persisted, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, resolvedPath);
  }

  async function change(jobId, transition) {
    return locked(async () => {
      const database = await readDatabase();
      const current = database.jobs[jobId];
      if (!current) throw new Error(`Unknown fulfillment job: ${jobId}`);
      const next = transition(current);
      if (next.environment !== "test") {
        throw new Error("The local fulfillment store cannot persist non-test jobs.");
      }
      database.jobs[jobId] = next;
      await writeDatabase(database);
      return structuredClone(next);
    });
  }

  return {
    authority: "local-test-only",

    async createJob(input, context) {
      return locked(async () => {
        const database = await readDatabase();
        const existing = database.jobs[input.jobId];
        if (existing) {
          const event = existing.events.find((entry) => entry.commandId === context.commandId);
          const expectedDigest = commandReplayDigest("job_created", {
            commandId: context.commandId,
            input,
          });
          if (event?.type === "job_created" && event.commandDigest === expectedDigest) {
            return structuredClone(existing);
          }
          if (event) throw new Error("Command replay does not match its original operation and payload.");
          throw new Error(`Fulfillment job already exists: ${input.jobId}`);
        }
        const aggregate = createJobAggregate(input, context);
        database.jobs[input.jobId] = aggregate;
        await writeDatabase(database);
        return structuredClone(aggregate);
      });
    },

    async getJob(jobId) {
      return locked(async () => {
        const database = await readDatabase();
        const aggregate = database.jobs[jobId];
        return aggregate ? structuredClone(aggregate) : null;
      });
    },

    recordPayment(jobId, payment, at) {
      return change(jobId, (aggregate) => recordPaymentTransition(aggregate, payment, at));
    },

    recordReviewDecision(jobId, decision, at) {
      return change(jobId, (aggregate) => recordReviewDecisionTransition(aggregate, decision, at));
    },

    claimStage(jobId, claim, at) {
      return locked(async () => {
        const database = await readDatabase();
        const current = database.jobs[jobId];
        if (!current) throw new Error(`Unknown fulfillment job: ${jobId}`);
        const replay = current.events.some((event) => event.commandId === claim.commandId);
        const next = claimStageTransition(current, claim, at);
        if (!replay) {
          if (next.environment !== "test") {
            throw new Error("The local fulfillment store cannot persist non-test jobs.");
          }
          database.jobs[jobId] = next;
          await writeDatabase(database);
        }
        return { aggregate: structuredClone(next), acquired: !replay };
      });
    },

    completeStage(jobId, completion, at) {
      return change(jobId, (aggregate) => completeStageTransition(aggregate, completion, at));
    },

    failStage(jobId, failure, policy, at) {
      return change(jobId, (aggregate) => failStageTransition(aggregate, failure, policy, at));
    },

    resumeRetry(jobId, command, at) {
      return change(jobId, (aggregate) => resumeRetryTransition(aggregate, command, at));
    },

    queueDelivery(jobId, command, at) {
      return change(jobId, (aggregate) => queueDeliveryTransition(aggregate, command, at));
    },

    confirmDelivery(jobId, confirmation, at) {
      return change(jobId, (aggregate) => confirmDeliveryTransition(aggregate, confirmation, at));
    },

    reconcileDelivery(jobId, reconciliation, at) {
      return change(jobId, (aggregate) => reconcileDeliveryTransition(aggregate, reconciliation, at));
    },
  };
}

function toPersistentDatabase(database) {
  return {
    schema_version: database.schemaVersion,
    authority: database.authority,
    jobs: Object.fromEntries(
      Object.entries(database.jobs).map(([jobId, aggregate]) => [jobId, mapKeysDeep(aggregate, camelToSnake)]),
    ),
  };
}

function fromPersistentDatabase(database) {
  return {
    schemaVersion: database.schema_version,
    authority: database.authority,
    jobs: Object.fromEntries(
      Object.entries(database.jobs).map(([jobId, aggregate]) => [jobId, mapKeysDeep(aggregate, snakeToCamel)]),
    ),
  };
}

function normalizePersistentDatabase(database) {
  if (database?.schema_version === "1.0") return database;
  // Read the pre-contract TEST-A projection once so the next accepted command migrates it.
  if (database?.schemaVersion === "1.0") return toPersistentDatabase(database);
  return database;
}

function assertValidPersistence(database) {
  if (!validatePersistence(database)) {
    throw new Error("Local fulfillment persistence schema validation failed.");
  }
}

function isCanonicalDateTime(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function mapKeysDeep(value, convertKey) {
  if (Array.isArray(value)) return value.map((entry) => mapKeysDeep(entry, convertKey));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [convertKey(key), mapKeysDeep(entry, convertKey)]),
  );
}

function camelToSnake(value) {
  return value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

function snakeToCamel(value) {
  return value.replace(/_([a-z])/g, (_, character) => character.toUpperCase());
}
