import { cronJobs, makeFunctionReference } from "convex/server";
const crons = cronJobs();
crons.interval("paid-data-lifecycle", { hours: 1 }, makeFunctionReference("deliveryLoopData:sweep"), {});
export default crons;
