/** Destructive drills ONLY in a newly generated, isolated Compose project.
 * No production .env, ports, credentials, broker account or AWS access is used.
 * Runtime image tags are supplied by CI; local defaults use explicitly built recovery images.
 * Always removes only this run's containers/volumes and writes a sanitized JSON report.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { productionEnvironmentErrors } from "./check-production-environment.mjs";

const project = `nralgo-recovery-${randomBytes(6).toString("hex")}`;
const runtime = resolve(".runtime");
mkdirSync(runtime, { recursive: true });
const temporary = mkdtempSync(join(runtime, `${project}-`));
const prefix = process.env.RELEASE_IMAGE_PREFIX || "nraialgo-recovery";
const tag = process.env.GITHUB_SHA ? `sha-${process.env.GITHUB_SHA}` : "local";
assert.match(prefix, /^[a-z0-9][a-z0-9./_-]*$/);
assert.match(tag, /^[a-zA-Z0-9-]+$/);
const report = {
  project,
  startedAt: new Date().toISOString(),
  checks: [],
  passed: false,
};
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  DOCKER_HOST: process.env.DOCKER_HOST,
  DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
  APP_DOMAIN: "recovery.invalid",
  SECRETS_DIR: temporary,
  LIVE_TRADING_ENABLED: "false",
  PAPER_TRADING_ENABLED: "false",
  KOTAK_STATIC_IP_CONFIRMED: "false",
  ALLOW_PUBLIC_REGISTRATION: "false",
  MARKET_DATA_PROVIDER: "kotak",
  BACKUP_S3_URI: "s3://recovery-validation-only/backups",
  AWS_REGION: "ap-south-1",
  ALERT_SNS_TOPIC_ARN: "arn:aws:sns:ap-south-1:123456789012:validation-only",
};
for (const name of [
  "BACKEND",
  "CALCULATION",
  "BACKUP",
  "WEB",
  "POSTGRES",
  "CADDY",
]) {
  env[`${name}_IMAGE`] = `placeholder@sha256:${"0".repeat(64)}`;
}
const file = join(temporary, "compose.json");
const baseArgs = [
  "compose",
  "--env-file",
  "/dev/null",
  "--project-name",
  project,
  "--file",
  file,
];
const docker = (args, options = {}) =>
  execFileSync("docker", args, {
    env,
    encoding: "utf8",
    timeout: 240000,
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
const compose = (args, options) => docker([...baseArgs, ...args], options);
const sql = (query, database = "nexus") =>
  compose(
    [
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "nexus",
      "-d",
      database,
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: query },
  ).trim();
const api = (code) =>
  compose([
    "exec",
    "-T",
    "api",
    "node",
    "--import",
    "./dist/backend/runtime-secrets.js",
    "--input-type=module",
    "-e",
    code,
  ]);
const backup = (args, options) =>
  compose(
    [
      "run",
      "--rm",
      "--no-deps",
      "backup",
      "node",
      "--import",
      "./dist/backend/runtime-secrets.js",
      ...args,
    ],
    options,
  );
function pass(name) {
  report.checks.push(name);
  console.debug(`PASS ${name}`);
}
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await check()) {
        return;
      }
    } catch {
      /* A restarted service may briefly be absent. */
    }
    await delay(500);
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  const config = JSON.parse(
    docker([
      "compose",
      "--env-file",
      "/dev/null",
      "--file",
      resolve("docker-compose.yml"),
      "config",
      "--format",
      "json",
    ]),
  );
  config.name = project;
  for (const [name, secret] of Object.entries(config.secrets)) {
    const path = join(temporary, name);
    writeFileSync(
      path,
      name.startsWith("zerodha_") || name === "registration_token"
        ? ""
        : randomBytes(32).toString("hex"),
      { mode: 0o444 },
    );
    chmodSync(path, 0o444);
    secret.file = path;
  }
  assert.deepEqual(productionEnvironmentErrors(env, null), []);
  assert.ok(
    productionEnvironmentErrors(
      { ...env, BACKEND_IMAGE: "image:latest" },
      null,
    ).some((error) => error.startsWith("BACKEND_IMAGE")),
  );
  assert.ok(
    productionEnvironmentErrors(
      { ...env, SETUP_TOKEN: "invalid-plaintext-fixture" },
      null,
    ).some((error) => error.includes("file-mounted")),
  );
  assert.ok(
    productionEnvironmentErrors({ ...env, ALERT_SNS_TOPIC_ARN: "" }, null).some(
      (error) => error.includes("ALERT_SNS_TOPIC_ARN"),
    ),
  );
  chmodSync(temporary, 0o755);
  assert.ok(
    productionEnvironmentErrors(env, null).some((error) =>
      error.includes("SECRETS_DIR"),
    ),
  );
  chmodSync(temporary, 0o700);
  pass(
    "deployment preflight rejects mutable images, plaintext secrets and missing alerts",
  );
  for (const [name, service] of Object.entries(config.services)) {
    service.restart = "no";
    delete service.ports;
    service.environment ||= {};
    service.environment.AWS_EC2_METADATA_DISABLED = "true";
    service.environment.LIVE_TRADING_ENABLED = "false";
    if (["api", "migrate"].includes(name)) {
      service.image = `${prefix}-backend:${tag}`;
    }
    if (name === "calculator") {
      service.image = `${prefix}-calculation:${tag}`;
      service.environment.CALCULATION_WALL_SECONDS = "5";
    }
    if (name === "web") {
      service.image = `${prefix}-web:${tag}`;
    }
    if (name === "db") {
      service.image = "postgres:17-alpine";
    }
    if (name === "backup") {
      service.image = `${prefix}-backup:${tag}`;
      service.environment.APP_ENV = "staging";
      service.environment.BACKUP_S3_URI = "";
    }
    assert.ok(
      service.mem_limit && service.cpus && service.pids_limit,
      `${name} missing resource bounds`,
    );
  }
  delete config.services.caddy; // No public listener or ACME call in a disposable drill.
  for (const network of Object.values(config.networks)) {
    delete network.name;
    network.internal = true;
  }
  for (const volume of Object.values(config.volumes)) {
    delete volume.name;
  }
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  compose([
    "up",
    "-d",
    "--no-build",
    "--wait",
    "--wait-timeout",
    "180",
    "db",
    "migrate",
    "calculator",
    "api",
    "web",
  ]);
  await until(
    () =>
      api(
        "const r=await fetch('http://127.0.0.1:8000/api/ready');if(!r.ok)process.exit(1)",
      ) !== null,
    "readiness",
  );
  pass("bounded images, mounted secrets, migrations and private readiness");

  const calculatorId = compose(["ps", "-q", "calculator"]).trim();
  const apiContainerId = compose(["ps", "-q", "api"]).trim();
  const [inspection] = JSON.parse(docker(["inspect", calculatorId]));
  assert.equal(inspection.HostConfig.Memory, 768 * 1024 * 1024);
  assert.equal(inspection.HostConfig.MemorySwap, inspection.HostConfig.Memory);
  assert.ok(
    inspection.HostConfig.NanoCpus > 0 && inspection.HostConfig.PidsLimit <= 64,
  );
  assert.ok(
    !inspection.Config.Env.some((value) =>
      /^(DATABASE_URL|BROKER_ENCRYPTION_KEY|SETUP_TOKEN)=/.test(value),
    ),
  );
  pass("calculator cgroup caps and broker-secret isolation");

  // Freeze a real child to make cancellation, crash and wall-time paths deterministic.
  const pythonDrill = String.raw`
import http.client, json, os, re, signal, time
from pathlib import Path
token=Path('/run/secrets/calculation_service_token').read_text().strip()
payload=json.dumps(dict(legs=[dict(right='call',side='buy',strike=25000,quantity=1,premium=100,iv=.2)],spot=25000,days=5,rate=.05,dividend=0,ivShift=0,targetSpot=25000,totalFees=0))
headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}
def request():
    c=http.client.HTTPConnection('127.0.0.1',8010,timeout=12)
    c.request('POST','/v1/options/payoff',payload,headers)
    return c
def ready():
    c=http.client.HTTPConnection('127.0.0.1',8010,timeout=2);c.request('GET','/health');v=json.loads(c.getresponse().read());c.close();return not v['busy']
def child():
    for _ in range(400):
        for p in Path('/proc').iterdir():
            if p.name.isdigit():
                try:
                    command=(p/'cmdline').read_bytes()
                    if b'spawn_main' in command and int(p.name)!=os.getpid():
                        limits=(p/'limits').read_text()
                        if re.search(r'Max address space\s+671088640\s+671088640',limits) and re.search(r'Max cpu time\s+60\s+65',limits): return int(p.name)
                except OSError: pass
        time.sleep(.005)
    raise AssertionError('child not spawned')
for kind in ['cancel','crash','timeout']:
    print('Python drill:',kind,flush=True)
    c=request();pid=child();os.kill(pid,signal.SIGSTOP)
    other=request();assert other.getresponse().status==503;other.close()
    if kind=='cancel': c.close()
    elif kind=='crash': os.kill(pid,signal.SIGKILL);assert c.getresponse().status==503;c.close()
    else: assert c.getresponse().status==504;c.close()
    for _ in range(160):
        if ready() and not Path(f'/proc/{pid}').exists(): break
        time.sleep(.05)
    else: raise AssertionError('orphan worker or busy gate remained')
c=request();response=c.getresponse();assert response.status==200;assert 'result' in json.loads(response.read());c.close()
for _ in range(100):
    if ready(): break
    time.sleep(.05)
else: raise AssertionError('completed child not reaped')
c=http.client.HTTPConnection('127.0.0.1',8010);c.request('POST','/v1/options/payoff','{}');assert c.getresponse().status==401;c.close()
c=http.client.HTTPConnection('127.0.0.1',8010)
try: c.request('POST','/v1/options/payoff',iter([b'x'*(1024*1024)]*9),headers,encode_chunked=True)
except BrokenPipeError: pass
status=c.getresponse().status;assert status==413,('oversized status',status);c.close()
print('Cancellation, crash, timeout, reuse, auth and chunked limits passed')
`;
  compose(["exec", "-T", "calculator", "python", "-c", pythonDrill], {
    timeout: 60000,
  });
  pass(
    "Python cancellation, child crash, deadline, serial admission and streaming limits",
  );

  const user = randomUUID(),
    job = randomUUID();
  const settings = {
    template: "ema",
    first: 5,
    second: 15,
    capital: 10000,
    allocation: 50,
    stop: 2,
    target: 4,
    fee: 0,
    slippage: 0,
  };
  const input = {
    instrumentId: "recovery-index",
    symbol: "RECOVERY",
    from: "2025-01-01",
    to: "2025-04-01",
    settings,
  };
  api(`
    import assert from 'node:assert/strict';
    import {CalculationClient} from './dist/backend/calculation-client.js';
    const client=new CalculationClient({...process.env,LIVE_TRADING_ENABLED:'true'});
    const bars=Array.from({length:60},(_,i)=>({date:new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10),open:100,high:102,low:99,close:101}));
    await assert.rejects(client.dailyBacktest(bars,${JSON.stringify(settings)}),error=>error.status===409);
  `);
  assert.equal(sql("SELECT COUNT(*) FROM live_orders"), "0");
  pass(
    "live-enabled configuration rejects heavy research without creating orders",
  );
  sql(`INSERT INTO users(id,username,password_hash) VALUES('${user}','recovery-only','not-a-login');
    INSERT INTO eod_instruments(id,symbol,name,kind,series,exchange) VALUES('recovery-index','RECOVERY','Synthetic recovery fixture','index','','NSE');
    INSERT INTO eod_candles(instrument_id,day,open,high,low,close,volume,source) SELECT 'recovery-index','2025-01-01'::date+n,100+n,102+n,99+n,101+n,1,'recovery-fixture' FROM generate_series(0,89)n;`);
  compose(["pause", "calculator"]);
  sql(
    `INSERT INTO calculation_jobs(id,user_id,kind,status,input) VALUES('${job}','${user}','daily-backtest','queued','${JSON.stringify(input)}');`,
  );
  await until(
    () =>
      sql(`SELECT status FROM calculation_jobs WHERE id='${job}'`) ===
      "running",
    "initial claim",
  );
  const claim = sql(
    `SELECT claim_token FROM calculation_jobs WHERE id='${job}'`,
  );
  compose(["kill", "-s", "SIGKILL", "api"]);
  docker(["start", apiContainerId]);
  await delay(3000);
  assert.equal(
    sql(`SELECT claim_token FROM calculation_jobs WHERE id='${job}'`),
    claim,
    "restart stole an unexpired claim",
  );
  compose(["unpause", "calculator"]);
  await until(
    () =>
      api(
        "const r=await fetch('http://127.0.0.1:8000/api/ready');if(!r.ok)process.exit(1)",
      ) !== null,
    "post-crash readiness",
  );
  // Advance only this disposable job's lease to exercise recovery without a 150-second wait.
  sql(
    `UPDATE calculation_jobs SET lease_until=NOW()-INTERVAL '1 second' WHERE id='${job}';`,
  );
  await until(
    () =>
      sql(`SELECT status FROM calculation_jobs WHERE id='${job}'`) ===
      "completed",
    "expired lease recovery",
    45000,
  );
  assert.equal(
    sql(`SELECT attempts FROM calculation_jobs WHERE id='${job}'`),
    "2",
  );
  pass(
    "API hard restart preserves leases and recovers expired work exactly once",
  );

  compose(["stop", "api"]);
  compose([
    "run",
    "--rm",
    "--no-deps",
    "api",
    "node",
    "--import",
    "./dist/backend/runtime-secrets.js",
    "--input-type=module",
    "-e",
    `
    import assert from 'node:assert/strict';
    import {CalculationJobRunner} from './dist/backend/calculation-jobs.js';
    import {openDatabaseStore} from './dist/backend/database.js';
    const store=openDatabaseStore();const query=(sql,args=[])=>store.transaction(q=>q(sql,args));
    let started;const began=new Promise(r=>started=r);let finish;const pending=new Promise(r=>finish=r);
    const client={dailyBacktest:async()=>{started();return pending;}};
    const a=new CalculationJobRunner(store,client),b=new CalculationJobRunner(store,client);
    await query("UPDATE calculation_jobs SET status='queued',claim_token=NULL,lease_until=NULL WHERE id=$1",['${job}']);
    const claims=await Promise.all([a.claim(),b.claim()]);assert.equal(claims.filter(Boolean).length,1);
    const old=claims.find(Boolean);const execution=a.execute(old);await began;
    await query("UPDATE calculation_jobs SET claim_token='replacement-owner' WHERE id=$1",['${job}']);
    finish({engineVersion:'stale',result:{}});await execution;
    assert.equal((await query('SELECT status FROM calculation_jobs WHERE id=$1',['${job}']))[0].status,'running');
    await query("UPDATE calculation_jobs SET attempts=3,lease_until=NOW()-INTERVAL '1 second' WHERE id=$1",['${job}']);
    await b.claim();assert.equal((await query('SELECT status FROM calculation_jobs WHERE id=$1',['${job}']))[0].status,'failed');
    a.close();b.close();await store.close();
  `,
  ]);
  docker(["start", apiContainerId]);
  pass("two claimers, stale result fencing and bounded recovery attempts");

  const cancelJob = randomUUID();
  compose(["pause", "calculator"]);
  sql(
    `INSERT INTO calculation_jobs(id,user_id,kind,status,input) VALUES('${cancelJob}','${user}','daily-backtest','queued','${JSON.stringify(input)}');`,
  );
  await until(
    () =>
      sql(`SELECT status FROM calculation_jobs WHERE id='${cancelJob}'`) ===
      "running",
    "cancellable claim",
  );
  sql(
    `UPDATE calculation_jobs SET cancel_requested=TRUE WHERE id='${cancelJob}';`,
  );
  await until(
    () =>
      sql(`SELECT status FROM calculation_jobs WHERE id='${cancelJob}'`) ===
      "cancelled",
    "cross-worker cancellation",
  );
  compose(["unpause", "calculator"]);
  pass("durable cancellation reaches the worker through its heartbeat");

  backup(["dist/backend/backup.js", "--once"]);
  const archive = backup([
    "--input-type=module",
    "-e",
    "import fs from 'node:fs';console.log(fs.readdirSync('/backups').filter(n=>n.endsWith('.dump.enc')).sort().at(-1));",
  ]).trim();
  assert.match(archive, /^nralgo-[\dTZ-]+\.dump\.enc$/);
  const dump = backup(
    [
      "--input-type=module",
      "-e",
      `import fs from 'node:fs';import cp from 'node:child_process';cp.execFileSync('node',['dist/backend/backup.js','--decrypt','/backups/${archive}','/tmp/restored.dump']);process.stdout.write(fs.readFileSync('/tmp/restored.dump'));`,
    ],
    { encoding: null },
  );
  sql("CREATE DATABASE recovery_restore;");
  compose(
    [
      "exec",
      "-T",
      "db",
      "pg_restore",
      "-U",
      "nexus",
      "-d",
      "recovery_restore",
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
    ],
    { input: dump },
  );
  assert.equal(
    sql(
      "SELECT COUNT(*) FROM eod_candles WHERE instrument_id='recovery-index'",
      "recovery_restore",
    ),
    "90",
  );
  assert.equal(
    sql(`SELECT COUNT(*) FROM users WHERE id='${user}'`, "recovery_restore"),
    "1",
  );
  backup([
    "--input-type=module",
    "-e",
    `import fs from 'node:fs';import cp from 'node:child_process';const data=fs.readFileSync('/backups/${archive}');data[data.length-1]^=1;fs.writeFileSync('/tmp/corrupt.enc',data);let rejected=false;try{cp.execFileSync('node',['dist/backend/backup.js','--decrypt','/tmp/corrupt.enc','/tmp/invalid.dump'],{stdio:'ignore'});}catch{rejected=true;}if(!rejected||fs.existsSync('/tmp/invalid.dump'))process.exit(1);`,
  ]);
  pass("encrypted backup restores actual rows and rejects tampered archives");
  compose(["restart", "db", "calculator", "api", "web"]);
  await until(
    () =>
      api(
        "const r=await fetch('http://127.0.0.1:8000/api/ready');if(!r.ok)process.exit(1)",
      ) !== null,
    "stack restart readiness",
    60000,
  );
  assert.equal(
    sql(`SELECT status FROM calculation_jobs WHERE id='${cancelJob}'`),
    "cancelled",
  );
  pass("database and service restart retain durable terminal states");
  report.passed = true;
} catch (error) {
  report.failure =
    error?.stderr?.toString().slice(-2000) ||
    (error instanceof Error
      ? error.message.slice(0, 2000)
      : "Recovery drill failed");
  if (error?.stdout) {
    console.error(error.stdout.toString().slice(-1000));
  }
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  try {
    assert.match(project, /^nralgo-recovery-[a-f0-9]{12}$/);
    compose(["unpause"], { timeout: 15000 });
  } catch {
    /* Services may not have started. */
  }
  try {
    compose(["down", "--volumes", "--remove-orphans"], { timeout: 60000 });
  } catch {
    report.cleanupFailed = true;
    process.exitCode = 1;
  }
  const reportPath = resolve(
    process.env.RECOVERY_REPORT || ".runtime/staging-recovery.json",
  );
  mkdirSync(resolve(reportPath, ".."), { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      { ...report, finishedAt: new Date().toISOString() },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  if (!report.cleanupFailed) {
    rmSync(temporary, { recursive: true, force: true });
  }
  console.debug(`Recovery report: ${reportPath}`);
}
