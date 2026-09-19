/** Explicit operator commands for an AWS Linux host. Never runs during app startup.
 * export-secrets reads one Secrets Manager JSON document into a NEW private directory.
 * protect-metadata blocks container IMDS access except the isolated backup network.
 * These commands provision no AWS infrastructure and print no secret values.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const names = [
  "POSTGRES_PASSWORD",
  "APP_DATABASE_PASSWORD",
  "BACKUP_DATABASE_PASSWORD",
  "BROKER_ENCRYPTION_KEY",
  "BACKUP_ENCRYPTION_KEY",
  "SETUP_TOKEN",
  "REGISTRATION_TOKEN",
  "CALCULATION_SERVICE_TOKEN",
  "ZERODHA_API_KEY",
  "ZERODHA_API_SECRET",
];
const optional = new Set([
  "REGISTRATION_TOKEN",
  "ZERODHA_API_KEY",
  "ZERODHA_API_SECRET",
]);

/** CloudWatch receives only operational counters, never trading data, credentials or raw errors. */
function aws(args) {
  return execFileSync("aws", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30000,
    maxBuffer: 65536,
  });
}
const deployment = process.env.DEPLOYMENT_NAME || "nraialgo-terminal";
const dimensions = [{ Name: "Deployment", Value: deployment }];
const thresholds = {
  ReadinessFailed: 0,
  UnhealthyServices: 0,
  BackupAgeHours: 26,
  MemoryUsedPercent: 85,
  DiskUsedPercent: 80,
};

try {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(deployment)) {
    throw new Error("Invalid deployment label.");
  }
  if (process.argv[2] === "export-secrets") {
    const destination = process.env.SECRETS_DIR;
    if (
      !destination ||
      !isAbsolute(destination) ||
      !process.env.SECRETS_MANAGER_ID
    ) {
      throw new Error("Set absolute SECRETS_DIR and SECRETS_MANAGER_ID.");
    }
    const document = JSON.parse(
      execFileSync(
        "aws",
        [
          "secretsmanager",
          "get-secret-value",
          "--secret-id",
          process.env.SECRETS_MANAGER_ID,
          "--query",
          "SecretString",
          "--output",
          "text",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 30000,
          maxBuffer: 65536,
        },
      ),
    );
    for (const name of names) {
      const value = document[name] ?? "";
      if (
        typeof value !== "string" ||
        value.includes("\n") ||
        value.length > 8192 ||
        (!optional.has(name) && value.length < 32)
      ) {
        throw new Error("Secret document is missing or has malformed fields.");
      }
    }
    // No recursive mkdir or overwrite: rotation uses a new versioned directory and a reviewed redeploy.
    mkdirSync(destination, { mode: 0o700 });
    for (const name of names) {
      const file = join(destination, name.toLowerCase());
      writeFileSync(file, document[name] ?? "", { flag: "wx", mode: 0o444 });
      chmodSync(file, 0o444); // Explicit mount recipients use different container UIDs; parent remains 0700.
    }
    console.log(
      "Mounted-secret files exported. Keep the encryption keys backed up separately.",
    );
  } else if (process.argv[2] === "protect-metadata") {
    if (process.platform !== "linux" || process.getuid?.() !== 0) {
      throw new Error(
        "Metadata protection requires an explicit root command on the Linux host.",
      );
    }
    const project = process.env.COMPOSE_PROJECT_NAME || "nraialgo-terminal";
    if (!/^[a-z0-9_-]+$/.test(project)) {
      throw new Error("Invalid Compose project name.");
    }
    const [network] = JSON.parse(
      execFileSync(
        "docker",
        ["network", "inspect", `${project}_backup_egress`],
        { encoding: "utf8" },
      ),
    );
    if (network.Labels?.["com.docker.compose.project"] !== project) {
      throw new Error("Backup network ownership mismatch.");
    }
    const subnet = network.IPAM.Config.find((value) =>
      /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(value.Subnet),
    )?.Subnet;
    if (!subnet) {
      throw new Error("Backup IPv4 subnet missing.");
    }
    for (const [command, chain, rule] of [
      [
        "iptables",
        "DOCKER-USER",
        ["-d", "169.254.169.254/32", "!", "-s", subnet, "-j", "DROP"],
      ],
      ["ip6tables", "FORWARD", ["-d", "fd00:ec2::254/128", "-j", "DROP"]],
    ]) {
      try {
        execFileSync(command, ["-C", chain, ...rule], { stdio: "ignore" });
      } catch {
        execFileSync(command, ["-I", chain, "1", ...rule], { stdio: "ignore" });
      }
    }
    console.log(
      "Container metadata restricted. Reapply after Docker/network recreation and host reboot.",
    );
  } else if (process.argv[2] === "configure-alerts") {
    const topic = process.env.ALERT_SNS_TOPIC_ARN || "";
    if (!/^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+$/.test(topic)) {
      throw new Error(
        "Set an existing SNS topic with a confirmed notification subscription.",
      );
    }
    for (const [metric, threshold] of Object.entries({
      ...thresholds,
      MonitorHeartbeat: 1,
    })) {
      aws([
        "cloudwatch",
        "put-metric-alarm",
        "--cli-input-json",
        JSON.stringify({
          AlarmName: `${deployment}-${metric}`,
          Namespace: "NRAlgo/Host",
          MetricName: metric,
          Dimensions: dimensions,
          Statistic: "Maximum",
          Period: 60,
          EvaluationPeriods: 3,
          Threshold: threshold,
          ComparisonOperator:
            metric === "MonitorHeartbeat"
              ? "LessThanThreshold"
              : "GreaterThanThreshold",
          TreatMissingData: "breaching",
          AlarmActions: [topic],
          OKActions: [topic],
          AlarmDescription:
            "Read-only alert. Never automatically restart services or submit orders.",
        }),
      ]);
    }
    console.debug(
      "CloudWatch alarms configured. Verify SNS delivery with a staging alarm drill.",
    );
  } else if (process.argv[2] === "monitor") {
    const metrics = {
      ReadinessFailed: 1,
      UnhealthyServices: 6,
      BackupAgeHours: 999,
      MonitorHeartbeat: 1,
    };
    const memory = readFileSync("/proc/meminfo", "utf8");
    const total = Number(memory.match(/^MemTotal:\s+(\d+)/m)?.[1]);
    const available = Number(memory.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
    metrics.MemoryUsedPercent =
      Number.isFinite(total) && total > 0 && Number.isFinite(available)
        ? 100 * (1 - available / total)
        : 100;
    const disk = statfsSync(
      process.env.DOCKER_DATA_DIRECTORY || "/var/lib/docker",
    );
    metrics.DiskUsedPercent =
      disk.blocks > 0 ? 100 * (1 - disk.bavail / disk.blocks) : 100;
    const compose = [
      "compose",
      "--env-file",
      ".env",
      "--env-file",
      ".env.release",
    ];
    try {
      const output = execFileSync(
        "docker",
        [...compose, "ps", "--all", "--format", "json"],
        { encoding: "utf8", timeout: 15000 },
      );
      const rows = output.trim().startsWith("[")
        ? JSON.parse(output)
        : output
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
      metrics.UnhealthyServices = [
        "db",
        "api",
        "calculator",
        "web",
        "caddy",
        "backup",
      ].filter(
        (name) =>
          !rows.some(
            (row) =>
              row.Service === name &&
              row.State === "running" &&
              (!row.Health || row.Health === "healthy"),
          ),
      ).length;
      const status = execFileSync(
        "docker",
        [
          ...compose,
          "exec",
          "-T",
          "backup",
          "node",
          "dist/backend/backup.js",
          "--status",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 10000,
        },
      );
      const age = JSON.parse(status).ageHours;
      if (Number.isFinite(age) && age >= 0) {
        metrics.BackupAgeHours = age;
      }
    } catch {
      /* Defaults deliberately report failure rather than a missing measurement. */
    }
    try {
      const domain = process.env.APP_DOMAIN;
      if (!/^[a-z0-9.-]+$/.test(domain || "")) {
        throw new Error("Invalid domain");
      }
      const response = await fetch(`https://${domain}/api/ready`, {
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      metrics.ReadinessFailed =
        response.ok && (await response.json()).ready === true ? 0 : 1;
    } catch {
      /* Keep failed readiness. */
    }
    aws([
      "cloudwatch",
      "put-metric-data",
      "--namespace",
      "NRAlgo/Host",
      "--metric-data",
      JSON.stringify(
        Object.entries(metrics).map(([MetricName, Value]) => ({
          MetricName,
          Value,
          Dimensions: dimensions,
        })),
      ),
    ]);
    console.debug(JSON.stringify({ deployment, ...metrics }));
  } else if (process.argv[2] === "install-monitor") {
    if (process.platform !== "linux" || process.getuid?.() !== 0) {
      throw new Error("Install requires root on the Linux host.");
    }
    const directory = resolve(process.cwd());
    if (!/^\/[A-Za-z0-9/_-]+$/.test(directory)) {
      throw new Error("Use a simple absolute deployment path.");
    }
    const units = {
      "nraialgo-monitor.service": `[Unit]\nDescription=NRAlgo operational metrics\nAfter=docker.service network-online.target\n[Service]\nType=oneshot\nWorkingDirectory=${directory}\nExecStart=/usr/bin/node --env-file=.env --env-file=.env.release scripts/host-operations.mjs monitor\nTimeoutStartSec=90\nNoNewPrivileges=true\nProtectSystem=strict\nProtectHome=true\nPrivateTmp=true\n`,
      "nraialgo-monitor.timer":
        "[Unit]\nDescription=NRAlgo monitoring heartbeat\n[Timer]\nOnBootSec=120\nOnUnitActiveSec=60\n[Install]\nWantedBy=timers.target\n",
      "nraialgo-metadata.service": `[Unit]\nDescription=Restrict container access to EC2 credentials\nAfter=docker.service\nRequires=docker.service\n[Service]\nType=oneshot\nWorkingDirectory=${directory}\nExecStart=/usr/bin/node --env-file=.env scripts/host-operations.mjs protect-metadata\nRemainAfterExit=yes\n[Install]\nWantedBy=multi-user.target\n`,
    };
    for (const [name, body] of Object.entries(units)) {
      writeFileSync(join("/etc/systemd/system", name), body, {
        flag: "wx",
        mode: 0o644,
      });
    }
    execFileSync("systemctl", ["daemon-reload"]);
    execFileSync("systemctl", [
      "enable",
      "--now",
      "nraialgo-monitor.timer",
      "nraialgo-metadata.service",
    ]);
    console.debug(
      "Monitoring timer and metadata protection installed; alarms require configure-alerts.",
    );
  } else {
    throw new Error(
      "Choose export-secrets, protect-metadata, configure-alerts, monitor or install-monitor.",
    );
  }
} catch {
  console.error(
    "Host operation failed. Check command, scoped IAM access, destination and host prerequisites; no secrets were logged.",
  );
  process.exitCode = 1;
}
