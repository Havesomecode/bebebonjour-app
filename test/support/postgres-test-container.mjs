import { spawnSync } from "node:child_process";

const unavailableImagePatterns = [
  /manifest unknown/i,
  /manifest (?:for .+ )?not found/i,
  /no matching manifest/i,
  /pull access denied/i,
  /repository does not exist/i,
  /requested access to the resource is denied/i,
  /failed to resolve reference.+not found/i,
];

function dockerOutput(result) {
  return [result.stdout, result.stderr, result.error?.message]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim())
    .join("\n");
}

function isUnavailableImage(output, image) {
  return output.includes(image)
    && unavailableImagePatterns.some((pattern) => pattern.test(output));
}

export function startPostgresTestContainer({
  containerName,
  image,
  runProcess = spawnSync,
}) {
  const result = runProcess(
    "docker",
    [
      "run",
      "--rm",
      "--detach",
      "--name",
      containerName,
      "--tmpfs",
      "/var/lib/postgresql/data:rw,size=512m",
      "--env",
      "POSTGRES_PASSWORD=test",
      "--env",
      "POSTGRES_DB=bebebonjour",
      image,
    ],
    { encoding: "utf8" },
  );

  if (result.status === 0) return result.stdout?.trim() || "";

  const output = dockerOutput(result);
  const status = result.status === null ? "unavailable" : result.status;
  if (isUnavailableImage(output, image)) {
    throw new Error(
      `PostgreSQL test image ${image} is unavailable.\n`
      + `Inspect it with \`docker image inspect ${image}\`, pull it with \`docker pull ${image}\`, `
      + "or set POSTGRES_TEST_IMAGE to an available PostgreSQL image.\n"
      + `Docker exit status: ${status}\n`
      + `Docker output:\n${output || "(none)"}`,
    );
  }

  throw new Error(
    `Failed to start PostgreSQL test container with image ${image}.\n`
    + `Docker exit status: ${status}\n`
    + `Docker output:\n${output || "(none)"}`,
  );
}
