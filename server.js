const crypto = require("crypto");
const express = require("express");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MAX_USERS = Number(process.env.MAX_USERS || 5);
const USER_TIMEOUT_MS = Number(process.env.USER_TIMEOUT_MS || 60_000);
const ENTRY_RATE_LIMIT_PER_SECOND = Number(
  process.env.ENTRY_RATE_LIMIT_PER_SECOND || 20
);

const SAMPLE_INTERVAL_MS = 1_000;
const HISTORY_LIMIT = 48;
const EVENT_LIMIT = 18;
const RATE_BASELINE_WINDOW_SECONDS = 12;
const SURGE_STDDEV_MULTIPLIER = 1.8;
const SURGE_MIN_ABSOLUTE_DELTA = 3;
const SURGE_COOLDOWN_MS = 10_000;
const NEW_USER_STDDEV_MULTIPLIER = 2.1;
const NEW_USER_MIN_ABSOLUTE_DELTA = 2;
const SURGE_GATE_FLOOR = 10;
const ONBOARDING_BLOCK_WINDOW_MS = 8_000;
const DYNAMIC_CAPACITY_FACTOR = 0.35;
const DYNAMIC_CAPACITY_MAX_MULTIPLIER = 5;
const REPUTATION_STRIKE_LIMIT = 3;
const REPUTATION_BLOCK_MS = 15_000;
const REPUTATION_DECAY_MS = 30_000;

const DEFAULT_SIMULATION_SECONDS = 30;
const SIMULATOR_POOL_SIZE = Math.max(MAX_USERS, Math.ceil(MAX_USERS * 1.5));
const SIMULATOR_PARALLEL_LIMIT = Math.max(2, Math.ceil(MAX_USERS * 0.75));
const SIMULATOR_TICK_MS = 350;
const REQUEST_STAGGER_MS = 160;
const HOLD_RANGE_MS = [7_000, 14_000];
const COOLDOWN_RANGE_MS = [900, 2_400];
const MIN_DYNAMIC_CAPACITY = MAX_USERS;
const MAX_DYNAMIC_CAPACITY = Math.max(
  Math.ceil(MAX_USERS * DYNAMIC_CAPACITY_MAX_MULTIPLIER),
  MAX_USERS + 20
);

let dynamicCapacityCap = MAX_USERS;

const activeUsers = new Map();
const ipReputation = new Map();
const dashboardClients = new Set();

const metrics = {
  startedAt: Date.now(),
  totalRequests: 0,
  allowedRequests: 0,
  blockedRequests: 0,
  throttledRequests: 0,
  onboardingBlocks: 0,
  reputationBlocks: 0,
  releasedSessions: 0,
  expiredSessions: 0,
  peakActiveUsers: 0,
  history: [],
  events: [],
};

function createAgent(index) {
  return {
    id: index + 1,
    name: `pool-${String(index + 1).padStart(2, "0")}`,
    ip: `10.24.0.${index + 10}`,
    state: "idle",
    token: null,
    requestTimer: null,
    holdTimer: null,
    cooldownTimer: null,
  };
}

const simulator = {
  running: false,
  startedAt: 0,
  durationMs: 0,
  tickTimer: null,
  stopTimer: null,
  agents: Array.from(
    { length: SIMULATOR_POOL_SIZE },
    (_unused, index) => createAgent(index)
  ),
  stats: {
    attempted: 0,
    allowed: 0,
    blocked: 0,
    recycled: 0,
  },
};

const trafficGuard = {
  secondWindowStartedAt: Date.now(),
  requestsThisSecond: 0,
  newEntriesThisSecond: 0,
  newEntryAttemptsThisSecond: 0,
  recentRates: Array.from(
    { length: RATE_BASELINE_WINDOW_SECONDS },
    () => 0
  ),
  recentNewEntryAttempts: Array.from(
    { length: RATE_BASELINE_WINDOW_SECONDS },
    () => 0
  ),
  currentRate: 0,
  baselineRate: 0,
  deviationRate: 0,
  thresholdRate: SURGE_MIN_ABSOLUTE_DELTA,
  currentNewEntryRate: 0,
  baselineNewEntryRate: 0,
  deviationNewEntryRate: 0,
  thresholdNewEntryRate: NEW_USER_MIN_ABSOLUTE_DELTA,
  surgeModeUntil: 0,
  wasInSurgeMode: false,
  onboardingBlockUntil: 0,
  wasOnboardingBlocked: false,
};

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function maybeUnref(timer) {
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
}

function shortToken(token) {
  return `${token.slice(0, 8)}...`;
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getReputation(ip) {
  const entry =
    ipReputation.get(ip) || { strikes: 0, blockedUntil: 0, lastStrikeAt: 0 };

  if (entry.lastStrikeAt && Date.now() - entry.lastStrikeAt > REPUTATION_DECAY_MS) {
    entry.strikes = 0;
  }

  ipReputation.set(ip, entry);
  return entry;
}

function recordReputationStrike(ip, reason) {
  const now = Date.now();
  const entry = getReputation(ip);

  entry.strikes += 1;
  entry.lastStrikeAt = now;

  if (entry.strikes >= REPUTATION_STRIKE_LIMIT) {
    entry.blockedUntil = Math.max(entry.blockedUntil, now + REPUTATION_BLOCK_MS);
    entry.strikes = 0;
    logEvent(
      "REPUTATION_BLOCK",
      `${ip} temporarily suppressed after repeated denials.`,
      { ip, reason, until: entry.blockedUntil }
    );
  }

  ipReputation.set(ip, entry);
}

function clearAgentTimers(agent) {
  for (const key of ["requestTimer", "holdTimer", "cooldownTimer"]) {
    if (agent[key]) {
      clearTimeout(agent[key]);
      agent[key] = null;
    }
  }
}

function roundToTenth(value) {
  return Math.round(value * 10) / 10;
}

function summarizeRates(values) {
  if (!values.length) {
    return { mean: 0, stddev: 0 };
  }

  const mean =
    values.reduce((total, value) => total + value, 0) / values.length;
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) /
    values.length;

  return {
    mean,
    stddev: Math.sqrt(variance),
  };
}

function isSurgeMode(now = Date.now()) {
  return trafficGuard.surgeModeUntil > now;
}

function isOnboardingBlocked(now = Date.now()) {
  return trafficGuard.onboardingBlockUntil > now;
}

function syncOnboardingGate(now = Date.now()) {
  const blocked = isOnboardingBlocked(now);

  if (trafficGuard.wasOnboardingBlocked && !blocked) {
    logEvent(
      "ONBOARDING_CLEAR",
      "New-user surge guard relaxed; onboarding reopened."
    );
  }

  trafficGuard.wasOnboardingBlocked = blocked;
}

function syncSurgeMode(now = Date.now()) {
  const surgeActive = isSurgeMode(now);

  if (trafficGuard.wasInSurgeMode && !surgeActive) {
    logEvent(
      "RELAX",
      "Entry rate normalized. The gateway returned to steady mode."
    );
  }

  trafficGuard.wasInSurgeMode = surgeActive;
}

function finalizeTrafficSecond(rate, newEntryRate, endedAt) {
  const reference = trafficGuard.recentRates.slice(
    -RATE_BASELINE_WINDOW_SECONDS
  );
  const stats = summarizeRates(reference);
  const threshold = Math.max(
    SURGE_MIN_ABSOLUTE_DELTA,
    Math.ceil(
      stats.mean +
        stats.stddev * SURGE_STDDEV_MULTIPLIER +
        SURGE_MIN_ABSOLUTE_DELTA
    )
  );

  trafficGuard.currentRate = rate;
  trafficGuard.baselineRate = roundToTenth(stats.mean);
  trafficGuard.deviationRate = roundToTenth(stats.stddev);
  trafficGuard.thresholdRate = threshold;

  const newRef = trafficGuard.recentNewEntryAttempts.slice(
    -RATE_BASELINE_WINDOW_SECONDS
  );
  const newStats = summarizeRates(newRef);
  const newEntryThreshold = Math.max(
    NEW_USER_MIN_ABSOLUTE_DELTA,
    Math.ceil(
      newStats.mean + newStats.stddev * NEW_USER_STDDEV_MULTIPLIER
    )
  );

  trafficGuard.currentNewEntryRate = newEntryRate;
  trafficGuard.baselineNewEntryRate = roundToTenth(newStats.mean);
  trafficGuard.deviationNewEntryRate = roundToTenth(newStats.stddev);
  trafficGuard.thresholdNewEntryRate = newEntryThreshold;

  if (rate > threshold) {
    const alreadyActive = isSurgeMode(endedAt);
    trafficGuard.surgeModeUntil = Math.max(
      trafficGuard.surgeModeUntil,
      endedAt + SURGE_COOLDOWN_MS
    );

    if (!alreadyActive) {
      logEvent(
        "SURGE",
        `Entry rate jumped to ${rate}/s. New entries are capped at ${Math.max(
          ENTRY_RATE_LIMIT_PER_SECOND,
          SURGE_GATE_FLOOR
        )}/s.`,
        {
          rate,
          baseline: trafficGuard.baselineRate,
          threshold,
        }
      );
    }
  }

  if (newEntryRate > newEntryThreshold) {
    const alreadyBlocked = isOnboardingBlocked(endedAt);
    trafficGuard.onboardingBlockUntil = Math.max(
      trafficGuard.onboardingBlockUntil,
      endedAt + ONBOARDING_BLOCK_WINDOW_MS
    );

    if (!alreadyBlocked) {
      logEvent(
        "ONBOARDING_BLOCK",
        `New-user surge detected at ${newEntryRate}/s (baseline ${trafficGuard.baselineNewEntryRate}/s, threshold ${newEntryThreshold}/s). Onboarding gated for ${Math.round(ONBOARDING_BLOCK_WINDOW_MS / 1_000)}s.`,
        {
          rate: newEntryRate,
          baseline: trafficGuard.baselineNewEntryRate,
          threshold: newEntryThreshold,
        }
      );
    }
  }

  const previousCap = dynamicCapacityCap;
  const proposedCap = Math.max(
    MIN_DYNAMIC_CAPACITY,
    Math.ceil(
      MAX_USERS + trafficGuard.baselineNewEntryRate * DYNAMIC_CAPACITY_FACTOR
    )
  );
  dynamicCapacityCap = clamp(proposedCap, MIN_DYNAMIC_CAPACITY, MAX_DYNAMIC_CAPACITY);

  if (dynamicCapacityCap !== previousCap) {
    logEvent(
      "CAP_ADAPT",
      `Dynamic capacity adjusted to ${dynamicCapacityCap} (baseline new users ${trafficGuard.baselineNewEntryRate}/s).`,
      {
        from: previousCap,
        to: dynamicCapacityCap,
      }
    );
  }

  trafficGuard.recentRates.push(rate);
  if (trafficGuard.recentRates.length > HISTORY_LIMIT) {
    trafficGuard.recentRates.shift();
  }

  trafficGuard.recentNewEntryAttempts.push(newEntryRate);
  if (trafficGuard.recentNewEntryAttempts.length > HISTORY_LIMIT) {
    trafficGuard.recentNewEntryAttempts.shift();
  }

  syncSurgeMode(endedAt);
}

function rollTrafficWindow(now = Date.now()) {
  while (now - trafficGuard.secondWindowStartedAt >= SAMPLE_INTERVAL_MS) {
    finalizeTrafficSecond(
      trafficGuard.requestsThisSecond,
      trafficGuard.newEntryAttemptsThisSecond,
      trafficGuard.secondWindowStartedAt + SAMPLE_INTERVAL_MS
    );
    trafficGuard.secondWindowStartedAt += SAMPLE_INTERVAL_MS;
    trafficGuard.requestsThisSecond = 0;
    trafficGuard.newEntriesThisSecond = 0;
    trafficGuard.newEntryAttemptsThisSecond = 0;
  }

  syncSurgeMode(now);
  syncOnboardingGate(now);
}

function isLocalRequest(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
    req.ip || req.socket?.remoteAddress || ""
  );
}

function requireLocal(req, res, next) {
  if (!isLocalRequest(req)) {
    return res
      .status(403)
      .json({ error: "Admin controls are limited to localhost." });
  }

  return next();
}

function findSessionByIp(ip) {
  for (const [token, session] of activeUsers) {
    if (session.ip === ip) {
      return { token, session };
    }
  }

  return null;
}

function logEvent(type, message, detail = {}) {
  metrics.events.unshift({
    type,
    message,
    time: Date.now(),
    detail,
  });
  metrics.events = metrics.events.slice(0, EVENT_LIMIT);
}

function getSimulatorStateCounts() {
  return simulator.agents.reduce(
    (counts, agent) => {
      counts[agent.state] += 1;
      return counts;
    },
    { idle: 0, requesting: 0, holding: 0, cooldown: 0 }
  );
}

function getBusyAgentCount() {
  return simulator.agents.filter((agent) => agent.state !== "idle").length;
}

function buildSessions() {
  return [...activeUsers.entries()]
    .sort((left, right) => left[1].createdAt - right[1].createdAt)
    .map(([token, session]) => {
      const ageMs = Date.now() - session.createdAt;
      return {
        token: shortToken(token),
        ip: session.ip,
        label: session.label,
        source: session.source,
        ageSeconds: Math.max(0, Math.round(ageMs / 1_000)),
        expiresInSeconds: Math.max(
          0,
          Math.ceil((USER_TIMEOUT_MS - ageMs) / 1_000)
        ),
      };
    });
}

function buildSnapshot() {
  rollTrafficWindow(Date.now());

  const surgeGateLimit = Math.max(ENTRY_RATE_LIMIT_PER_SECOND, SURGE_GATE_FLOOR);
  const blockRate =
    metrics.totalRequests === 0
      ? 0
      : Math.round((metrics.blockedRequests / metrics.totalRequests) * 100);
  const surgeMode = isSurgeMode();

  return {
    activeUsers: activeUsers.size,
    maxUsers: dynamicCapacityCap,
    baseCapacity: MAX_USERS,
    dynamicCapacity: dynamicCapacityCap,
    timeoutSeconds: Math.round(USER_TIMEOUT_MS / 1_000),
    sessions: buildSessions(),
    metrics: {
      totalRequests: metrics.totalRequests,
      allowedRequests: metrics.allowedRequests,
      blockedRequests: metrics.blockedRequests,
      throttledRequests: metrics.throttledRequests,
      onboardingBlocks: metrics.onboardingBlocks,
      reputationBlocks: metrics.reputationBlocks,
      releasedSessions: metrics.releasedSessions,
      expiredSessions: metrics.expiredSessions,
      peakActiveUsers: metrics.peakActiveUsers,
      blockRate,
      uptimeSeconds: Math.round((Date.now() - metrics.startedAt) / 1_000),
    },
    simulator: {
      running: simulator.running,
      poolSize: SIMULATOR_POOL_SIZE,
      parallelLimit: SIMULATOR_PARALLEL_LIMIT,
      durationSeconds: Math.round(simulator.durationMs / 1_000),
      elapsedSeconds: simulator.startedAt
        ? Math.round((Date.now() - simulator.startedAt) / 1_000)
        : 0,
      states: getSimulatorStateCounts(),
      busyAgents: getBusyAgentCount(),
      attempted: simulator.stats.attempted,
      allowed: simulator.stats.allowed,
      blocked: simulator.stats.blocked,
      recycled: simulator.stats.recycled,
    },
    traffic: {
      surgeMode,
      onboardingBlocked: isOnboardingBlocked(),
      allowedPerSecond: surgeGateLimit,
      liveRate: trafficGuard.requestsThisSecond,
      lastSecondRate: trafficGuard.currentRate,
      baselineRate: trafficGuard.baselineRate,
      deviationRate: trafficGuard.deviationRate,
      thresholdRate: trafficGuard.thresholdRate,
      liveNewEntryRate: trafficGuard.newEntryAttemptsThisSecond,
      lastSecondNewEntryRate: trafficGuard.currentNewEntryRate,
      baselineNewEntryRate: trafficGuard.baselineNewEntryRate,
      deviationNewEntryRate: trafficGuard.deviationNewEntryRate,
      thresholdNewEntryRate: trafficGuard.thresholdNewEntryRate,
      admittedNewEntriesThisSecond: trafficGuard.newEntriesThisSecond,
      gateRemainingThisSecond: surgeMode
        ? Math.max(
            0,
            surgeGateLimit - trafficGuard.newEntriesThisSecond
          )
        : surgeGateLimit,
      cooldownSeconds: surgeMode
        ? Math.max(
            0,
            Math.ceil((trafficGuard.surgeModeUntil - Date.now()) / 1_000)
          )
        : 0,
      onboardingBlockSeconds: isOnboardingBlocked()
        ? Math.max(
            0,
            Math.ceil((trafficGuard.onboardingBlockUntil - Date.now()) / 1_000)
          )
        : 0,
    },
    history: metrics.history,
    events: metrics.events,
  };
}

function broadcastSnapshot() {
  const payload = `data: ${JSON.stringify(buildSnapshot())}\n\n`;

  for (const client of dashboardClients) {
    try {
      client.write(payload);
    } catch {
      dashboardClients.delete(client);
    }
  }
}

function captureSample() {
  rollTrafficWindow(Date.now());

  metrics.history.push({
    time: Date.now(),
    activeUsers: activeUsers.size,
    dynamicCapacity: dynamicCapacityCap,
    simulatorBusy: getBusyAgentCount(),
    totalRequests: metrics.totalRequests,
    blockedRequests: metrics.blockedRequests,
    requestRate: trafficGuard.currentRate,
    thresholdRate: trafficGuard.thresholdRate,
    newEntryRate: trafficGuard.currentNewEntryRate,
    newEntryThreshold: trafficGuard.thresholdNewEntryRate,
    surgeMode: isSurgeMode(),
    onboardingBlocked: isOnboardingBlocked(),
  });

  if (metrics.history.length > HISTORY_LIMIT) {
    metrics.history.shift();
  }

  broadcastSnapshot();
}

function onSimulatorSessionClosed(agentId, reason) {
  const agent = simulator.agents.find((item) => item.id === agentId);
  if (!agent) {
    return;
  }

  clearAgentTimers(agent);
  agent.token = null;

  if (!simulator.running) {
    agent.state = "idle";
    return;
  }

  logEvent("RECYCLE", `${agent.name} returned to the pool. Reason: ${reason}.`, {
    agentId,
  });

  agent.state = "cooldown";
  agent.cooldownTimer = maybeUnref(
    setTimeout(() => {
      agent.cooldownTimer = null;
      agent.state = "idle";
      simulator.stats.recycled += 1;
      launchSimulatorWave();
      broadcastSnapshot();
    }, randomBetween(COOLDOWN_RANGE_MS[0], COOLDOWN_RANGE_MS[1]))
  );
}

function closeSession(token, reason, options = {}) {
  const session = activeUsers.get(token);
  if (!session) {
    return false;
  }

  clearTimeout(session.timer);
  activeUsers.delete(token);

  if (reason === "expired") {
    metrics.expiredSessions += 1;
  } else {
    metrics.releasedSessions += 1;
  }

  if (!options.silent) {
    const type = reason === "expired" ? "EXPIRED" : "RELEASED";
    const message =
      reason === "expired"
        ? `${session.label} (${session.ip}) timed out.`
        : `${session.label} (${session.ip}) ${reason}.`;
    logEvent(type, message, {
      ip: session.ip,
      source: session.source,
      token: shortToken(token),
    });
  }

  if (session.agentId) {
    onSimulatorSessionClosed(session.agentId, reason);
  }

  broadcastSnapshot();
  return true;
}

function requestAccess({ ip, source, label, agentId = null }) {
  const now = Date.now();
  rollTrafficWindow(now);

  metrics.totalRequests += 1;
  trafficGuard.requestsThisSecond += 1;

  const existing = findSessionByIp(ip);
  if (existing) {
    metrics.allowedRequests += 1;
    logEvent("REUSED", `${label} reused ${shortToken(existing.token)}.`, {
      ip,
      source,
      token: shortToken(existing.token),
    });
    broadcastSnapshot();
    return { allowed: true, token: existing.token, reused: true };
  }

  trafficGuard.newEntryAttemptsThisSecond += 1;

  if (isOnboardingBlocked(now)) {
    metrics.blockedRequests += 1;
    metrics.onboardingBlocks += 1;
    recordReputationStrike(ip, "onboarding-blocked");
    logEvent(
      "BLOCKED_NEW",
      `${label} (${ip}) blocked due to new-user surge guard.`,
      { ip, source, reason: "onboarding-blocked" }
    );
    broadcastSnapshot();
    return {
      allowed: false,
      reason: "onboarding-blocked",
      message:
        "High influx of new users detected. Please retry shortly while onboarding stabilizes.",
    };
  }

  const reputation = getReputation(ip);
  if (reputation.blockedUntil > now) {
    metrics.blockedRequests += 1;
    metrics.reputationBlocks += 1;
    logEvent(
      "REPUTATION_DENY",
      `${label} (${ip}) suppressed by reputation cooldown.`,
      { ip, source, reason: "reputation-blocked" }
    );
    broadcastSnapshot();
    return {
      allowed: false,
      reason: "reputation-blocked",
      message: "Source temporarily suppressed after repeated denials.",
    };
  }

  const surgeGateLimit = Math.max(ENTRY_RATE_LIMIT_PER_SECOND, SURGE_GATE_FLOOR);
  if (isSurgeMode(now) && trafficGuard.newEntriesThisSecond >= surgeGateLimit) {
    metrics.blockedRequests += 1;
    metrics.throttledRequests += 1;
    recordReputationStrike(ip, "surge-throttled");
    logEvent(
      "THROTTLED",
      `${label} (${ip}) was held at the surge gate after ${surgeGateLimit} new entries in the current second.`,
      { ip, source, reason: "surge-throttled" }
    );
    broadcastSnapshot();
    return {
      allowed: false,
      reason: "surge-throttled",
      message: `Traffic spike detected. New entries are temporarily limited to ${surgeGateLimit}/s.`,
    };
  }

  if (activeUsers.size >= dynamicCapacityCap) {
    metrics.blockedRequests += 1;
    logEvent(
      "BLOCKED",
      `${label} (${ip}) was denied at ${activeUsers.size}/${dynamicCapacityCap}.`,
      { ip, source, cap: dynamicCapacityCap }
    );
    broadcastSnapshot();
    return {
      allowed: false,
      reason: "capacity-full",
      message: "Capacity is full right now.",
    };
  }

  trafficGuard.newEntriesThisSecond += 1;

  const token = crypto.randomBytes(16).toString("hex");
  const session = {
    ip,
    source,
    label,
    agentId,
    createdAt: Date.now(),
    timer: null,
  };

  session.timer = maybeUnref(
    setTimeout(() => closeSession(token, "expired"), USER_TIMEOUT_MS)
  );

  activeUsers.set(token, session);
  metrics.allowedRequests += 1;
  metrics.peakActiveUsers = Math.max(metrics.peakActiveUsers, activeUsers.size);

  logEvent("ALLOWED", `${label} (${ip}) received ${shortToken(token)}.`, {
    ip,
    source,
    token: shortToken(token),
  });
  broadcastSnapshot();

  return { allowed: true, token, reused: false };
}

function scheduleAgentAttempt(agent, delayMs) {
  clearAgentTimers(agent);
  agent.state = "requesting";

  agent.requestTimer = maybeUnref(
    setTimeout(() => {
      agent.requestTimer = null;

      if (!simulator.running || agent.state !== "requesting") {
        agent.state = "idle";
        broadcastSnapshot();
        return;
      }

      simulator.stats.attempted += 1;

      const result = requestAccess({
        ip: agent.ip,
        source: "simulator",
        label: agent.name,
        agentId: agent.id,
      });

      if (!result.allowed) {
        simulator.stats.blocked += 1;
        agent.state = "cooldown";
        agent.cooldownTimer = maybeUnref(
          setTimeout(() => {
            agent.cooldownTimer = null;
            agent.state = "idle";
            simulator.stats.recycled += 1;
            launchSimulatorWave();
            broadcastSnapshot();
          }, randomBetween(COOLDOWN_RANGE_MS[0], COOLDOWN_RANGE_MS[1]))
        );
        broadcastSnapshot();
        return;
      }

      simulator.stats.allowed += 1;
      agent.state = "holding";
      agent.token = result.token;

      const holdMs = randomBetween(HOLD_RANGE_MS[0], HOLD_RANGE_MS[1]);
      agent.holdTimer = maybeUnref(
          setTimeout(() => {
          agent.holdTimer = null;
          if (agent.token) {
            closeSession(agent.token, "completed its hold window", {
              silent: true,
            });
          }
        }, holdMs)
      );

      broadcastSnapshot();
    }, delayMs)
  );
}

function launchSimulatorWave() {
  if (!simulator.running) {
    return;
  }

  const requestingCount = simulator.agents.filter(
    (agent) => agent.state === "requesting"
  ).length;
  const availableLaunches = SIMULATOR_PARALLEL_LIMIT - requestingCount;

  if (availableLaunches <= 0) {
    return;
  }

  const idleAgents = simulator.agents
    .filter((agent) => agent.state === "idle")
    .slice(0, availableLaunches);

  idleAgents.forEach((agent, index) => {
    scheduleAgentAttempt(agent, index * REQUEST_STAGGER_MS);
  });
}

function stopSimulator(reason = "stopped by operator") {
  const wasRunning = simulator.running;
  simulator.running = false;

  if (simulator.tickTimer) {
    clearInterval(simulator.tickTimer);
    simulator.tickTimer = null;
  }

  if (simulator.stopTimer) {
    clearTimeout(simulator.stopTimer);
    simulator.stopTimer = null;
  }

  for (const agent of simulator.agents) {
    clearAgentTimers(agent);
  }

  const tokensToRelease = simulator.agents
    .map((agent) => agent.token)
    .filter(Boolean);

  for (const token of tokensToRelease) {
    closeSession(token, "was cleared during simulator shutdown", {
      silent: true,
    });
  }

  for (const agent of simulator.agents) {
    agent.token = null;
    agent.state = "idle";
  }

  if (wasRunning) {
    logEvent("SIM_STOP", `Local simulator stopped: ${reason}.`, { reason });
  }

  broadcastSnapshot();
}

function startSimulator(durationSeconds = DEFAULT_SIMULATION_SECONDS) {
  if (simulator.running) {
    return buildSnapshot();
  }

  const boundedSeconds = clamp(
    Math.round(durationSeconds),
    10,
    180
  );

  simulator.running = true;
  simulator.startedAt = Date.now();
  simulator.durationMs = boundedSeconds * 1_000;
  simulator.stats = {
    attempted: 0,
    allowed: 0,
    blocked: 0,
    recycled: 0,
  };

  for (const agent of simulator.agents) {
    clearAgentTimers(agent);
    agent.state = "idle";
    agent.token = null;
  }

  simulator.tickTimer = maybeUnref(
    setInterval(launchSimulatorWave, SIMULATOR_TICK_MS)
  );
  simulator.stopTimer = maybeUnref(
    setTimeout(
      () => stopSimulator("time window completed"),
      simulator.durationMs
    )
  );

  logEvent(
    "SIM_START",
    `Local simulator started for ${boundedSeconds}s. Pool ${SIMULATOR_POOL_SIZE}, parallel attempts ${SIMULATOR_PARALLEL_LIMIT}.`,
    {
      durationSeconds: boundedSeconds,
      poolSize: SIMULATOR_POOL_SIZE,
      parallelLimit: SIMULATOR_PARALLEL_LIMIT,
    }
  );

  launchSimulatorWave();
  broadcastSnapshot();
  return buildSnapshot();
}

app.post("/api/request-access", (req, res) => {
  const result = requestAccess({
    ip: req.ip,
    source: "browser",
    label: "browser visitor",
  });

  res.json(result);
});

app.post("/api/leave", (req, res) => {
  const token = req.body?.token;

  if (token) {
    closeSession(token, "left the site");
  }

  res.json({ success: true });
});

app.get("/api/status", (_req, res) => {
  res.json(buildSnapshot());
});

app.get("/api/dashboard/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  dashboardClients.add(res);
  res.write(`data: ${JSON.stringify(buildSnapshot())}\n\n`);

  req.on("close", () => {
    dashboardClients.delete(res);
  });
});

app.post("/api/simulator/start", requireLocal, (req, res) => {
  const snapshot = startSimulator(req.body?.durationSeconds);
  res.json({ success: true, snapshot });
});

app.post("/api/simulator/stop", requireLocal, (_req, res) => {
  stopSimulator("stopped from admin controls");
  res.json({ success: true, snapshot: buildSnapshot() });
});

captureSample();
maybeUnref(setInterval(captureSample, SAMPLE_INTERVAL_MS));

app.listen(PORT, () => {
  console.log();
  console.log("==============================================");
  console.log(" Security Gateway Waiting Room Demo");
  console.log("==============================================");
  console.log(` Visitor page      : http://localhost:${PORT}`);
  console.log(` Admin dashboard   : http://localhost:${PORT}/admin.html`);
  console.log(
    ` Capacity cap      : base ${MAX_USERS}, adaptive start ${dynamicCapacityCap}`
  );
  console.log(
    ` Surge gate        : min ${Math.max(
      ENTRY_RATE_LIMIT_PER_SECOND,
      SURGE_GATE_FLOOR
    )} new entries/s`
  );
  console.log(` Session timeout   : ${USER_TIMEOUT_MS / 1_000}s`);
  console.log(` Simulator pool    : ${SIMULATOR_POOL_SIZE} agents`);
  console.log(` Parallel attempts : ${SIMULATOR_PARALLEL_LIMIT}`);
  console.log("==============================================");
  console.log();
});
