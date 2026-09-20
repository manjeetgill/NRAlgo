/** Encrypted PostgreSQL backups, optional off-server S3 upload and age-based health checks.
 * Runs separately from the API. Never logs credentials or passes passwords in process arguments.
 * Keep BACKUP_ENCRYPTION_KEY outside the server: losing it makes these archives unrecoverable.
 */
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
  unlink,
  open,
  rename,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const backupDirectory = "/backups";
const healthFile = resolve(backupDirectory, "last-success");
/** Obtain a fixed-size encryption key without exposing it through logs or command arguments. */
function encryptionKey(): Buffer {
  const value = process.env.BACKUP_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(
      "Configure BACKUP_ENCRYPTION_KEY as 64 random hex characters.",
    );
  }
  return Buffer.from(value, "hex");
}
/** Launch a database utility with standard PG* environment variables and bounded execution time. */
function databaseProcess(command: string, args: string[]) {
  const timeoutSeconds = Number(
    process.env.BACKUP_DATABASE_TIMEOUT_SECONDS || 1800,
  );
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 60 ||
    timeoutSeconds > 21600
  ) {
    throw new Error(
      "BACKUP_DATABASE_TIMEOUT_SECONDS must be between 60 and 21600.",
    );
  }
  const url = new URL(process.env.DATABASE_URL || "");
  const child = spawn(command, args, {
    env: {
      PATH: process.env.PATH,
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: url.pathname.slice(1),
      PGCONNECT_TIMEOUT: "10",
    },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutSeconds * 1000,
  });
  const completed = new Promise<void>((resolve, reject) => {
    child.on("error", () => reject(new Error("Backup utility failed.")));
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Backup utility failed.")),
    );
  });
  return { child, completed };
}
/** Create an authenticated archive: 4-byte version, 12-byte IV, ciphertext, 16-byte GCM tag. */
async function createBackup() {
  if (process.env.APP_ENV === "production" && !process.env.BACKUP_S3_URI) {
    throw new Error("Production requires off-server backups.");
  }
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const name = `nralgo-${new Date().toISOString().replace(/[:.]/g, "-")}.dump.enc`;
  const temporary = resolve(backupDirectory, `${name}.partial`),
    destination = resolve(backupDirectory, name);
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from("NRA1"));
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  output.write(Buffer.concat([Buffer.from("NRA1"), iv]));
  const { child, completed } = databaseProcess("pg_dump", [
    "-Fc",
    "--no-owner",
    "--no-acl",
  ]);
  try {
    await Promise.all([pipeline(child.stdout!, cipher, output), completed]);
    const handle = await open(temporary, "a");
    try {
      await handle.write(cipher.getAuthTag());
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    // Bound disk usage even when off-server uploads repeatedly fail.
    const archives = (await readdir(backupDirectory))
      .filter((entry) => /^nralgo-[\dTZ-]+\.dump\.enc$/.test(entry))
      .sort()
      .reverse();
    for (const entry of archives.slice(14)) {
      await unlink(resolve(backupDirectory, entry));
    }
    const s3 = process.env.BACKUP_S3_URI;
    if (s3) {
      if (!/^s3:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9/_-]*)?$/.test(s3)) {
        throw new Error("Invalid BACKUP_S3_URI.");
      }
      await new Promise<void>((resolve, reject) => {
        const upload = spawn(
          "aws",
          [
            "s3",
            "cp",
            destination,
            `${s3.replace(/\/$/, "")}/${name}`,
            "--sse",
            "AES256",
            "--checksum-algorithm",
            "SHA256",
            "--only-show-errors",
          ],
          {
            stdio: "ignore",
            timeout: 300000,
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              AWS_REGION: process.env.AWS_REGION,
            },
          },
        );
        upload.on("error", () =>
          reject(new Error("Off-server backup failed.")),
        );
        upload.on("exit", (code) =>
          code === 0
            ? resolve()
            : reject(new Error("Off-server backup failed.")),
        );
      });
      // A successful process exit alone is insufficient: verify the remote object's length.
      const location = new URL(`${s3.replace(/\/$/, "")}/${name}`);
      const remoteSize = await new Promise<number>((resolve, reject) => {
        const check = spawn(
          "aws",
          [
            "s3api",
            "head-object",
            "--bucket",
            location.hostname,
            "--key",
            location.pathname.slice(1),
            "--query",
            "ContentLength",
            "--output",
            "text",
          ],
          {
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 30000,
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              AWS_REGION: process.env.AWS_REGION,
            },
          },
        );
        let output = "";
        check.stdout.on("data", (chunk) => {
          output += String(chunk);
          if (output.length > 1000) {
            check.kill();
          }
        });
        check.on("error", () =>
          reject(new Error("Off-server verification failed.")),
        );
        check.on("exit", (code) =>
          code === 0
            ? resolve(Number(output.trim()))
            : reject(new Error("Off-server verification failed.")),
        );
      });
      if (remoteSize !== (await stat(destination)).size) {
        throw new Error("Off-server backup size mismatch.");
      }
    }
    const marker = `${healthFile}.partial`;
    await writeFile(marker, String(Date.now()), { mode: 0o600 });
    await rename(marker, healthFile);
    // Delete only this service's encrypted archives older than 14 days, never arbitrary files.
    for (const entry of await readdir(backupDirectory)) {
      if (/^nralgo-[\dTZ-]+\.dump\.enc$/.test(entry)) {
        const path = resolve(backupDirectory, entry);
        if (Date.now() - (await stat(path)).mtimeMs > 14 * 86400000) {
          await unlink(path);
        }
      }
    }
    console.debug(
      s3
        ? "Encrypted local and off-server backup complete."
        : "Encrypted local backup complete. Configure S3 for protection against server loss.",
    );
  } catch (error) {
    child.kill("SIGTERM");
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
/** Authenticate before publishing a decrypted dump. Output must not already exist. */
async function decryptBackup(input: string, output: string) {
  const source = await open(input, "r"),
    size = (await source.stat()).size;
  if (size < 32) {
    throw new Error("Invalid archive.");
  }
  const header = Buffer.alloc(16),
    tag = Buffer.alloc(16);
  await source.read(header, 0, 16, 0);
  await source.read(tag, 0, 16, size - 16);
  await source.close();
  if (header.subarray(0, 4).toString() !== "NRA1") {
    throw new Error("Unsupported archive.");
  }
  const cipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    header.subarray(4),
  );
  cipher.setAAD(Buffer.from("NRA1"));
  cipher.setAuthTag(tag);
  const temporary = `${output}.${randomBytes(8).toString("hex")}.partial`;
  try {
    await pipeline(
      createReadStream(input, { start: 16, end: size - 17 }),
      cipher,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    // Hard-link is atomic and fails if output already exists, preventing accidental overwrites.
    const { link } = await import("node:fs/promises");
    await link(temporary, output);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

try {
  if (
    process.argv.includes("--healthcheck") ||
    process.argv.includes("--status")
  ) {
    const lastSuccess = Number(await readFile(healthFile, "utf8"));
    const ageHours = (Date.now() - lastSuccess) / 3600000;
    if (process.argv.includes("--status")) {
      console.debug(JSON.stringify({ ageHours }));
    }
    if (!Number.isFinite(lastSuccess) || ageHours < 0 || ageHours > 26) {
      process.exitCode = 1;
    }
  } else if (process.argv[2] === "--decrypt") {
    if (!process.argv[3] || !process.argv[4]) {
      throw new Error("Provide input and output archive paths.");
    }
    await decryptBackup(process.argv[3], process.argv[4]);
  } else if (process.argv.includes("--once")) {
    await createBackup();
  } else {
    for (;;) {
      try {
        await createBackup();
        await delay(86400000);
      } catch {
        console.error(
          "Scheduled backup failed; retrying in 15 minutes. Check backup health and storage access.",
        );
        await delay(900000);
      }
    }
  }
} catch {
  console.error(
    "Backup operation failed. Check configuration, disk, database and off-server access.",
  );
  process.exitCode = 1;
}
