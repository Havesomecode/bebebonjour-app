const ERROR_MESSAGES = Object.freeze({
  invalid_intake: "Vérifiez les informations saisies puis réessayez.",
  job_not_found: "Cette demande est introuvable ou a expiré.",
  origin_not_allowed: "Cette page ne peut pas accéder au service.",
  request_too_large: "La demande est trop volumineuse.",
  payment_correlation_failed: "Le paiement ne correspond pas à cette demande.",
  test_access_required: "Le jeton d’accès TEST-A est requis pour continuer.",
});

const CANONICAL_HOSTED_API_BASE_URL = "https://bebebonjour-fulfillment.vercel.app/api/customer-flow";

export class FulfillmentApiError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "FulfillmentApiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function createFulfillmentClient({
  baseUrl,
  getTestAccessToken,
  fetchImpl = globalThis.fetch,
  createId = () => globalThis.crypto.randomUUID(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  const normalizedBaseUrl = apiBaseUrl(baseUrl);
  const isHosted = normalizedBaseUrl.startsWith("https://");
  let testAccessToken = null;
  let pendingIntake = null;

  return {
    submitIntake(intake) {
      const body = JSON.stringify(intake);
      if (!pendingIntake || pendingIntake.body !== body) {
        pendingIntake = {
          body,
          idempotencyKey: `intake_${createId().replaceAll("-", "")}`,
        };
      }
      const submission = pendingIntake;
      return request("/v1/intakes", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": submission.idempotencyKey,
        },
        body,
        retryNetworkOnce: true,
      }).then((result) => {
        if (pendingIntake === submission) pendingIntake = null;
        return result;
      });
    },

    getStatus(jobId, intakeToken) {
      return authorizedRequest(`/v1/jobs/${encodeIdentifier(jobId)}/status`, "GET", intakeToken);
    },

    createCheckout(jobId, intakeToken) {
      return authorizedRequest(`/v1/jobs/${encodeIdentifier(jobId)}/checkout`, "POST", intakeToken);
    },
  };

  function authorizedRequest(pathname, method, intakeToken) {
    if (typeof intakeToken !== "string" || intakeToken.length < 8) {
      return Promise.reject(new FulfillmentApiError(404, "job_not_found", ERROR_MESSAGES.job_not_found));
    }
    return request(pathname, {
      method,
      headers: { authorization: `Bearer ${intakeToken}` },
    });
  }

  async function request(pathname, options) {
    let response;
    const { retryNetworkOnce = false, ...fetchOptions } = options;
    if (isHosted && testAccessToken === null) {
      const candidate = typeof getTestAccessToken === "function" ? getTestAccessToken() : null;
      const normalizedCandidate = typeof candidate === "string" ? candidate.trim() : "";
      if (normalizedCandidate.length < 32) {
        throw new FulfillmentApiError(
          401,
          "test_access_required",
          ERROR_MESSAGES.test_access_required,
        );
      }
      testAccessToken = normalizedCandidate;
    }
    if (isHosted) {
      fetchOptions.headers = {
        ...fetchOptions.headers,
        "x-test-a-access-token": testAccessToken,
      };
    }
    for (let attempt = 0; attempt < (retryNetworkOnce ? 2 : 1); attempt += 1) {
      try {
        response = await fetchImpl(`${normalizedBaseUrl}${pathname}`, {
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          ...fetchOptions,
        });
        break;
      } catch {
        if (!retryNetworkOnce || attempt === 1) throw unavailableError();
      }
    }

    let payload = null;
    if (String(response.headers.get("content-type") || "").includes("application/json")) {
      try {
        payload = await response.json();
      } catch {
        throw unavailableError(response.status);
      }
    }
    if (!response.ok) {
      const code = typeof payload?.error?.code === "string" ? payload.error.code : "request_failed";
      const message = ERROR_MESSAGES[code] || "Le service est momentanément indisponible. Réessayez.";
      throw new FulfillmentApiError(response.status, code, message);
    }
    if (!payload || typeof payload !== "object") throw unavailableError(response.status);
    return payload;
  }
}

function apiBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalidApiBaseUrl();
  }

  const isOriginOnly = !url.username && !url.password
    && url.pathname === "/" && !url.search && !url.hash;
  const isLoopback = url.protocol === "http:"
    && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    && isOriginOnly;
  if (isLoopback) return url.origin;

  if (value === CANONICAL_HOSTED_API_BASE_URL) return CANONICAL_HOSTED_API_BASE_URL;
  throw invalidApiBaseUrl();
}

function invalidApiBaseUrl() {
  return new Error(
    "TEST-A API base URL must be a loopback HTTP origin or the exact canonical hosted API base URL.",
  );
}

function encodeIdentifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new FulfillmentApiError(404, "job_not_found", ERROR_MESSAGES.job_not_found);
  }
  return encodeURIComponent(value);
}

function unavailableError(statusCode = 503) {
  return new FulfillmentApiError(
    statusCode,
    "request_failed",
    "Le service est momentanément indisponible. Réessayez.",
  );
}
