export function createConvexOperationsCommandQueue(options = {}) {
  const { client, workerToken } = options;
  if (!client || typeof client.mutation !== "function") {
    throw new Error("Convex operations queue requires a mutation client.");
  }
  if (typeof workerToken !== "string" || workerToken.length < 32) {
    throw new Error("Convex operations queue worker token is invalid.");
  }

  const mutate = (name, payload) => client.mutation(name, { workerToken, ...payload });

  return Object.freeze({
    claimCommands(input) {
      return mutate("operations:claimCommands", input);
    },
    fenceCommand(input) {
      return mutate("operations:fenceCommand", input);
    },
    completeCommand(input) {
      return mutate("operations:completeCommand", input);
    },
    failCommand(input) {
      return mutate("operations:failCommand", input);
    },
  });
}
