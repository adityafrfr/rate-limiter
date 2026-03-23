const SERVER = process.env.SERVER || "http://localhost:3000";
const POLL_INTERVAL_MS = 1_000;
const DURATION_SECONDS = Math.max(
  10,
  Math.min(180, Number(process.env.DEMO_DURATION_SECONDS) || 30)
);
const DASHBOARD_URL = new URL("/admin.html", SERVER).href;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const response = await fetch(`${SERVER}${path}`, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `Request failed with ${response.status}`);
  }

  return data;
}

function printSnapshot(snapshot) {
  const observedRate = Math.max(
    snapshot.traffic.liveRate,
    snapshot.traffic.lastSecondRate
  );

  process.stdout.write("\x1Bc");

  console.log("==============================================");
  console.log(" Bounded Traffic Pressure Demo");
  console.log("==============================================");
  console.log(` Target              : ${SERVER}`);
  console.log(` Duration            : ${DURATION_SECONDS}s`);
  console.log(` Site capacity       : ${snapshot.maxUsers} active sessions`);
  console.log(
    ` Simulator pool      : ${snapshot.simulator.poolSize} agents`
  );
  console.log(
    ` Entry gate          : ${snapshot.traffic.allowedPerSecond}/s during surge mode`
  );
  console.log("==============================================");
  console.log();

  console.log(
    `Active slots         : ${snapshot.activeUsers}/${snapshot.maxUsers}`
  );
  console.log(
    `Busy pool agents     : ${snapshot.simulator.busyAgents}/${snapshot.simulator.poolSize}`
  );
  console.log(`Simulator state      : ${snapshot.simulator.running ? "RUNNING" : "IDLE"}`);
  console.log(
    `Elapsed              : ${snapshot.simulator.elapsedSeconds}s / ${snapshot.simulator.durationSeconds}s`
  );
  console.log(
    `Traffic guard        : ${snapshot.traffic.surgeMode ? "SURGE" : "NORMAL"}`
  );
  console.log(
    `Rate / threshold     : ${observedRate}/s vs ${snapshot.traffic.thresholdRate}/s`
  );
  console.log();

  console.log(`Total checks         : ${snapshot.metrics.totalRequests}`);
  console.log(`Allowed              : ${snapshot.metrics.allowedRequests}`);
  console.log(`Blocked              : ${snapshot.metrics.blockedRequests}`);
  console.log(`Block rate           : ${snapshot.metrics.blockRate}%`);
  console.log(`Peak occupancy       : ${snapshot.metrics.peakActiveUsers}/${snapshot.maxUsers}`);
  console.log(`Recycled agents      : ${snapshot.simulator.recycled}`);
  console.log();

  console.log("Recent events:");
  if (!snapshot.events.length) {
    console.log("  - no events yet");
  } else {
    for (const event of snapshot.events.slice(0, 6)) {
      const time = new Date(event.time).toLocaleTimeString();
      console.log(`  - [${time}] ${event.type}: ${event.message}`);
    }
  }

  console.log();
  console.log(`Open ${DASHBOARD_URL} for the live dashboard.`);
  console.log("Press Ctrl+C to stop the demo early.");
}

async function stopSimulator() {
  try {
    await request("/api/simulator/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch (_error) {
  }
}

async function main() {
  await request("/api/simulator/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ durationSeconds: DURATION_SECONDS }),
  });

  while (true) {
    const snapshot = await request("/api/status");
    printSnapshot(snapshot);

    if (!snapshot.simulator.running && snapshot.simulator.elapsedSeconds > 0) {
      break;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  const finalSnapshot = await request("/api/status");
  printSnapshot(finalSnapshot);
  console.log();
  console.log("Demo finished. The simulator pool has been returned to idle.");
}

process.on("SIGINT", async () => {
  await stopSimulator();
  process.exit(0);
});

main().catch((error) => {
  console.error();
  console.error("Unable to run the bounded demo controller.");
  console.error(error.message);
  process.exit(1);
});
