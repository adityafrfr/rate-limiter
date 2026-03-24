const enterBtn = document.getElementById("enter-btn");
const statusMsg = document.getElementById("status-msg");
const adminStats = document.getElementById("admin-stats");

const summaryActive = document.getElementById("summary-active");
const summaryBlockRate = document.getElementById("summary-block-rate");
const summaryPool = document.getElementById("summary-pool");
const summaryMode = document.getElementById("summary-mode");

enterBtn.addEventListener("click", async () => {
  enterBtn.disabled = true;
  statusMsg.textContent = "Checking availability...";
  statusMsg.className = "status-msg";

  try {
    const response = await fetch("/api/request-access", {
      method: "POST",
    });
    const data = await response.json();

    if (data.allowed) {
      statusMsg.textContent = "Access granted. Redirecting...";
      statusMsg.classList.add("success");
      sessionStorage.setItem("gateway-token", data.token);
      setTimeout(() => {
        window.location.href = "site.html";
      }, 700);
      return;
    }

    statusMsg.textContent =
      data.message ||
      (data.reason === "surge-throttled"
        ? data.message
        : "Capacity is full. Redirecting...");
    statusMsg.classList.add("error");
    setTimeout(() => {
      window.location.href = `blocked.html?reason=${encodeURIComponent(
        data.reason || "capacity-full"
      )}`;
    }, 700);
  } catch (_error) {
    statusMsg.textContent = "Error connecting to the gateway.";
    statusMsg.classList.add("error");
    enterBtn.disabled = false;
  }
});

function renderSessionsTable(sessions) {
  if (!sessions.length) {
    return '<p class="muted-copy">No active sessions right now.</p>';
  }

  const rows = sessions
    .slice(0, 6)
    .map(
      (session) => `
        <tr>
          <td>${session.label}</td>
          <td>${session.source}</td>
          <td>${session.ageSeconds}s</td>
          <td>${session.expiresInSeconds}s</td>
        </tr>
      `
    )
    .join("");

  return `
    <div class="compact-metrics">
      <p><strong>Total attempts:</strong> ${window.gatewaySnapshot.metrics.totalRequests}</p>
      <p><strong>Allowed:</strong> ${window.gatewaySnapshot.metrics.allowedRequests}</p>
      <p><strong>Blocked:</strong> ${window.gatewaySnapshot.metrics.blockedRequests}</p>
      <p><strong>Peak occupancy:</strong> ${window.gatewaySnapshot.metrics.peakActiveUsers}/${window.gatewaySnapshot.maxUsers}</p>
    </div>
    <table class="admin-table">
      <thead>
        <tr>
          <th>Session</th>
          <th>Source</th>
          <th>Age</th>
          <th>TTL</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function refreshStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    window.gatewaySnapshot = data;

    summaryActive.textContent = `${data.activeUsers} / ${data.dynamicCapacity}`;
    summaryBlockRate.textContent = `${data.metrics.blockRate}%`;
    summaryPool.textContent = `${data.simulator.busyAgents} / ${data.simulator.poolSize}`;
    summaryMode.textContent = data.traffic.surgeMode
      ? "Surge guard"
      : data.traffic.onboardingBlocked
        ? "New-user gated"
        : data.simulator.running
          ? "Sim running"
          : "Normal";

    adminStats.innerHTML = renderSessionsTable(data.sessions);
  } catch (_error) {
    adminStats.innerHTML =
      '<p class="muted-copy">Unable to fetch live status.</p>';
  }
}

refreshStatus();
setInterval(refreshStatus, 2_000);
