/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as automaticGeneration from "../automaticGeneration.js";
import type * as canonicalCompletionScope from "../canonicalCompletionScope.js";
import type * as customerFlow from "../customerFlow.js";
import type * as deliveryLoop from "../deliveryLoop.js";
import type * as deliveryLoopHttp from "../deliveryLoopHttp.js";
import type * as deliveryLoopProviders from "../deliveryLoopProviders.js";
import type * as fulfillment from "../fulfillment.js";
import type * as generation from "../generation.js";
import type * as http from "../http.js";
import type * as narration from "../narration.js";
import type * as narrationHttp from "../narrationHttp.js";
import type * as narrationRuntime from "../narrationRuntime.js";
import type * as narrationScope from "../narrationScope.js";
import type * as operations from "../operations.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  automaticGeneration: typeof automaticGeneration;
  canonicalCompletionScope: typeof canonicalCompletionScope;
  customerFlow: typeof customerFlow;
  deliveryLoop: typeof deliveryLoop;
  deliveryLoopHttp: typeof deliveryLoopHttp;
  deliveryLoopProviders: typeof deliveryLoopProviders;
  fulfillment: typeof fulfillment;
  generation: typeof generation;
  http: typeof http;
  narration: typeof narration;
  narrationHttp: typeof narrationHttp;
  narrationRuntime: typeof narrationRuntime;
  narrationScope: typeof narrationScope;
  operations: typeof operations;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
