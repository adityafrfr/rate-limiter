const durationInput = document.getElementById("duration-seconds");
const startButton = document.getElementById("start-demo");
const stopButton = document.getElementById("stop-demo");
const controlStatus = document.getElementById("control-status");

const metricCapacity = document.getElementById("metric-capacity");
const metricBlockRate = document.getElementById("metric-block-rate");
const metricPool = document.getElementById("metric-pool");
const metricParallel = document.getElementById("metric-parallel");

const capacityCaption = document.getElementById("capacity-caption");
const capacityFill = document.getElementById("capacity-fill");
const capacityText = document.getElementById("capacity-text");

const poolCaption = document.getElementById("pool-caption");
const poolFill = document.getElementById("pool-fill");
const poolText = document.getElementById("pool-text");

const stateGrid = document.getElementById("state-grid");
const eventFeed = document.getElementById("event-feed");
const sessionCaption = document.getElementById("session-caption");
const sessionsBody = document.getElementById("sessions-body");

const chartActiveLine = document.getElementById("chart-active-line");
const chartPoolLine = document.getElementById("chart-pool-line");

let eventStream = null;

function setMeter(fillNode, current, total) {
  const percentage =
    total === 0 ? 0 : Math.min(100, Math.round((current / total) * 100));
  fillNode.style.width = `${percentage}%`;
}

function buildPolyline(values, maxValue) {
  const width = 600;
  const height = 220;
  const safeMax = Math.max(1, maxValue);

  if (!values.length) {
    return `0,${height - 12} ${width},${height - 12}`;
  }

  return values
    .map((value, index) => {
      const x =
        values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
      const normalized = Math.min(value, safeMax) / safeMax;
      const y = height - 12 - normalized * (height - 24);
      return `${x},${y}`;
    })
    .join(" ");
}

function renderStates(states) {
  const labels = [
    ["Idle", states.idle],
    ["Requesting", states.requesting],
    ["Holding", states.holding],
    ["Cooldown", states.cooldown],
  ];

  stateGrid.innerHTML = labels
    .map(
      ([label, value]) => `
        <div class="state-card">
          <span>${label}</span>
          <strong>${value}</strong>
        </div>
      `
    )
    .join("");
}

function renderEvents(events) {
  if (!events.length) {
    eventFeed.innerHTML =
      '<p class="muted-copy">No decisions have been recorded yet.</p>';
    return;
  }

  eventFeed.innerHTML = events
    .slice(0, 12)
    .map((event) => {
      const time = new Date(event.time).toLocaleTimeString();
      return `
        <article class="event-item">
          <div class="event-head">
            <span class="pill">${event.type}</span>
            <time>${time}</time>
          </div>
          <p>${event.message}</p>
        </article>
      `;
    })
    .join("");
}

function renderSessions(sessions) {
  sessionCaption.textContent = `${sessions.length} session${
    sessions.length === 1 ? "" : "s"
  }`;

  if (!sessions.length) {
    sessionsBody.innerHTML =
      '<tr><td colspan="5" class="table-empty">No active sessions.</td></tr>';
    return;
  }

  sessionsBody.innerHTML = sessions
    .map(
      (session) => `
        <tr>
          <td>${session.label}</td>
          <td>${session.source}</td>
          <td>${session.ip}</td>
          <td>${session.ageSeconds}s</td>
          <td>${session.expiresInSeconds}s</td>
        </tr>
      `
    )
    .join("");
}

function renderChart(snapshot) {
  const activeSeries = snapshot.history.map((point) => point.activeUsers);
  const poolSeries = snapshot.history.map((point) => point.simulatorBusy);

  chartActiveLine.setAttribute(
    "points",
    buildPolyline(activeSeries, snapshot.maxUsers)
  );
  chartPoolLine.setAttribute(
    "points",
    buildPolyline(poolSeries, snapshot.simulator.poolSize)
  );
}

function renderSnapshot(snapshot) {
  const observedRate = Math.max(
    snapshot.traffic.liveRate,
    snapshot.traffic.lastSecondRate
  );
  const observedNewRate = Math.max(
    snapshot.traffic.liveNewEntryRate,
    snapshot.traffic.lastSecondNewEntryRate
  );

  metricCapacity.textContent = `${snapshot.activeUsers} / ${snapshot.dynamicCapacity}`;
  metricBlockRate.textContent = `${snapshot.metrics.blockRate}%`;
  metricPool.textContent = `${snapshot.simulator.busyAgents} / ${snapshot.simulator.poolSize}`;
  metricParallel.textContent = `${snapshot.traffic.allowedPerSecond}/s`;

  capacityCaption.textContent = snapshot.traffic.onboardingBlocked
    ? "New-user gated"
    : snapshot.traffic.surgeMode
      ? "Surge"
      : "Stable";
  capacityText.textContent = `Req ${observedRate}/s (baseline ${snapshot.traffic.baselineRate}/s, threshold ${snapshot.traffic.thresholdRate}/s). New users ${observedNewRate}/s (baseline ${snapshot.traffic.baselineNewEntryRate}/s, threshold ${snapshot.traffic.thresholdNewEntryRate}/s). Dynamic cap ${snapshot.dynamicCapacity} (base ${snapshot.baseCapacity}).`;
  setMeter(
    capacityFill,
    Math.max(observedRate, observedNewRate),
    Math.max(
      snapshot.traffic.thresholdRate,
      snapshot.traffic.thresholdNewEntryRate,
      snapshot.traffic.allowedPerSecond
    )
  );

  poolCaption.textContent = snapshot.simulator.running ? "Running" : "Idle";
  poolText.textContent = `${snapshot.simulator.recycled} agents have completed a recycle loop.`;
  setMeter(poolFill, snapshot.simulator.busyAgents, snapshot.simulator.poolSize);

  controlStatus.textContent = snapshot.traffic.onboardingBlocked
    ? `Onboarding surge guard active for about ${snapshot.traffic.onboardingBlockSeconds}s.`
    : snapshot.traffic.surgeMode
      ? `Surge guard active. New entries are limited to ${snapshot.traffic.allowedPerSecond}/s for about ${snapshot.traffic.cooldownSeconds}s.`
      : snapshot.simulator.running
        ? `Simulator running for ${snapshot.simulator.elapsedSeconds}s of ${snapshot.simulator.durationSeconds}s.`
        : "The simulator is local-only and capped at 150% of site capacity.";

  startButton.disabled = snapshot.simulator.running;
  stopButton.disabled = !snapshot.simulator.running;

  renderStates(snapshot.simulator.states);
  renderEvents(snapshot.events);
  renderSessions(snapshot.sessions);
  renderChart(snapshot);
}

async function loadSnapshot() {
  const response = await fetch("/api/status");
  if (!response.ok) {
    throw new Error("Unable to load status.");
  }
  return response.json();
}

async function postControl(url, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data.snapshot;
}

async function startDemo() {
  const durationSeconds = Math.max(
    10,
    Math.min(180, Number(durationInput.value) || 30)
  );

  controlStatus.textContent = "Starting bounded demo traffic...";

  try {
    const snapshot = await postControl("/api/simulator/start", {
      durationSeconds,
    });
    renderSnapshot(snapshot);
  } catch (error) {
    controlStatus.textContent = error.message;
  }
}

async function stopDemo() {
  controlStatus.textContent = "Stopping simulator...";

  try {
    const snapshot = await postControl("/api/simulator/stop");
    renderSnapshot(snapshot);
  } catch (error) {
    controlStatus.textContent = error.message;
  }
}

function connectStream() {
  if (eventStream) {
    eventStream.close();
  }

  eventStream = new EventSource("/api/dashboard/stream");
  eventStream.onmessage = (event) => {
    renderSnapshot(JSON.parse(event.data));
  };
  eventStream.onerror = async () => {
    if (eventStream) {
      eventStream.close();
      eventStream = null;
    }

    try {
      renderSnapshot(await loadSnapshot());
    } catch (_error) {
      controlStatus.textContent = "Dashboard connection lost.";
    }

    setTimeout(connectStream, 1_500);
  };
}

startButton.addEventListener("click", startDemo);
stopButton.addEventListener("click", stopDemo);

loadSnapshot()
  .then(renderSnapshot)
  .catch(() => {
    controlStatus.textContent = "Unable to load dashboard data.";
  });

connectStream();
