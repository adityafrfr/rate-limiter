# Adaptive Security Gateway for Surge-Aware Admission Control

## Abstract

This project is a research-oriented cybersecurity prototype that studies how a lightweight web gateway can regulate access during sudden traffic increases. The system models a protected website entrance using three coordinated controls: a concurrent-session cap, a deviation-based surge detector, and a temporary admission throttle. A bounded local simulator is used to generate repeatable pressure against the gateway, while a live dashboard visualizes system state, traffic conditions, and decision outcomes in real time. The prototype is intended for academic demonstration and analysis of admission control behavior under abnormal request rates. It is not a production mitigation platform and is not designed for real-world offensive use.

## Keywords

- admission control
- waiting room
- surge detection
- rate limiting
- concurrent session limiting
- cybersecurity prototype
- traffic anomaly response
- operational monitoring

## Research Context

Modern public-facing services often face two related problems:

- they can become overloaded when too many users attempt to enter simultaneously
- they may experience sudden spikes in request rate that differ significantly from normal behavior

Commercial platforms such as CDN and edge-protection providers address these problems with large-scale infrastructure, distributed filtering, and advanced telemetry. This project does not attempt to replicate those systems. Instead, it implements a small research prototype that captures a narrow but useful subset of the problem:

- deciding whether a new visitor should be admitted
- limiting concurrent occupancy of a protected resource
- identifying unusual entry-rate deviation from a recent baseline
- slowing new admissions during a temporary surge window
- visualizing those decisions for observation and analysis

The prototype is therefore best understood as a local model of adaptive admission control at the edge of a protected service.

## Problem Statement

If access control depends only on a fixed concurrent-user limit, the system can still be stressed by sudden request bursts before human operators understand what is happening. Conversely, if access control depends only on simple per-second rate limiting, the system may fail to distinguish between ordinary fluctuations and unusual spikes relative to normal traffic. This project explores whether a combined model can behave more clearly and predictably:

- a hard limit to protect the protected resource from excess concurrent occupancy
- a rolling baseline to estimate what "normal" traffic looks like
- a surge detector that reacts when the current rate deviates sharply from that baseline
- a temporary per-second admission cap that stays active while the surge condition persists

## Research Objectives

The prototype was built around the following objectives:

1. Model a protected entrance rather than an entire infrastructure stack.
2. Demonstrate the difference between concurrent-session limiting and dynamic rate-aware admission control.
3. Implement a deviation-based surge detector that adapts to recent traffic rather than relying only on a fixed threshold.
4. Visualize gateway decisions in real time so that the behavior is inspectable during experiments.
5. Keep the simulator bounded, local, and ethically constrained for academic use.

## Research Questions

This implementation supports discussion of questions such as:

1. How does a concurrent session cap behave under sustained access pressure?
2. How does a rolling baseline plus deviation threshold affect admission decisions during sudden spikes?
3. What is the difference between capacity exhaustion and temporary surge throttling from an operational perspective?
4. Can a bounded client pool produce repeatable experimental pressure suitable for classroom or college-level research demonstration?

## Scope and Ethical Boundary

This repository is intended for local research, demonstration, and educational evaluation only.

It is explicitly not:

- a production DDoS defense platform
- a reverse proxy or CDN
- a web application firewall
- a distributed mitigation layer
- a bot-management system
- a tool for real-world disruption or offensive deployment

The simulator included in this repository is deliberately bounded:

- it uses a fixed pool of local agents
- it caps simultaneous request openings
- it recycles connections rather than generating unlimited traffic

This design keeps the project aligned with academic demonstration rather than offensive automation.

## System Overview

At runtime, the project behaves like a small website behind a security gateway:

1. A visitor requests access through the gateway.
2. The gateway evaluates traffic conditions and active capacity.
3. If admitted, the visitor receives a temporary session token.
4. If denied, the visitor is redirected to a waiting or busy page.
5. A live admin dashboard displays telemetry about traffic, sessions, simulator activity, and surge state.

The implementation is composed of four main layers:

- admission-control backend
- visitor-facing gateway pages
- live monitoring dashboard
- bounded local simulator

## Core Research Contributions of the Prototype

Within the narrow scope of this college project, the implementation contributes the following:

- a combined model of concurrency-based protection and deviation-based surge response
- a live telemetry view that exposes the internal gateway state
- a reproducible local simulation model based on a fixed client pool
- a clear separation between capacity denial and surge-throttling denial

These are prototype-level contributions, not production claims.

## Protection Model

### 1. Concurrent Session Limiting

The gateway maintains an in-memory set of active sessions. Each admitted session:

- receives a generated token
- occupies one active slot
- expires automatically after a timeout
- may also be released explicitly when the visitor leaves the protected page

Default value:

- `MAX_USERS = 5`

If all active slots are occupied, new entrants are denied with `reason = "capacity-full"`.

### 2. Adaptive Surge Detection

The server tracks incoming access attempts in one-second windows. It keeps a rolling baseline over recent seconds and computes a deviation-based threshold:

`threshold = max(3, ceil(mean(last 12 seconds) + 1.5 * stddev + 3))`

Where:

- `mean(last 12 seconds)` is the average recent request rate
- `stddev` is the standard deviation of recent rates
- `3` is a minimum absolute deviation floor used by this prototype

If the current per-second request rate exceeds that threshold, the system enters surge mode.

### 3. Surge-Mode Admission Gate

While surge mode is active:

- new entries are capped at `20` per second by default
- the cap applies to new admissions, not to already active sessions
- the system remains in surge mode for a cooldown window after the anomaly is observed

Default value:

- `ENTRY_RATE_LIMIT_PER_SECOND = 20`
- `SURGE_COOLDOWN_MS = 10000`

If the temporary gate is exhausted during surge mode, the request is denied with `reason = "surge-throttled"`.

### 4. Bounded Local Simulator

The project includes a local simulator to create repeatable pressure during experiments. The simulator is intentionally constrained:

- pool size = `ceil(MAX_USERS * 1.5)`
- simultaneous request openings are capped separately
- each agent can request, hold, release, cool down, and re-enter the pool

With the default configuration:

- `MAX_USERS = 5`
- simulator pool size = `8`
- parallel request openings = `4`

This produces churn and measurable pressure without open-ended connection generation.

### 5. Live Monitoring Dashboard

The admin dashboard receives telemetry through Server-Sent Events and exposes:

- active sessions
- occupancy of the protected resource
- total, allowed, blocked, and throttled requests
- simulator state and recycling behavior
- surge versus stable mode
- recent event feed
- time-series pressure chart

This is useful for observational analysis during demonstrations and experiments.

## Decision Logic

When a request reaches `POST /api/request-access`, the gateway evaluates it in the following order:

1. Update rolling traffic counters.
2. Check whether the same IP already holds an active session.
3. If surge mode is active and the current second has already consumed the surge admission allowance, deny with `surge-throttled`.
4. If concurrent session capacity is already full, deny with `capacity-full`.
5. Otherwise, create a new session and admit the visitor.

This ordering is intentional. It separates two different protective behaviors:

- surge throttling: abnormal rate response
- capacity denial: concurrent occupancy protection

## Experimental Model

### Normal Condition

Under ordinary request rates:

- the system remains in stable mode
- new entries are processed normally
- only the concurrent capacity cap limits access

### Surge Condition

When request rate suddenly rises beyond recent statistical expectation:

- the gateway enters surge mode
- a temporary admission gate becomes active
- the dashboard displays the surge state and related telemetry

### Sustained Occupancy Pressure

When the protected site remains full:

- new admissions are denied due to capacity exhaustion
- occupied sessions persist until timeout or explicit release
- simulator agents recycle and attempt re-entry according to pool rules

## Metrics Observed by the System

The prototype captures the following metrics:

- total requests
- allowed requests
- blocked requests
- throttled requests
- released sessions
- expired sessions
- peak active users
- block rate
- active session list
- simulator pool state
- recent rate baseline
- recent deviation estimate
- current threshold
- surge cooldown remaining

These metrics are returned through the status API and displayed in the dashboard.

## Implementation Architecture

### Backend

The main backend is [server.js](/home/tamatar/Documents/College/bisek/server.js). It is responsible for:

- static asset serving
- active session tracking
- rolling traffic analysis
- surge detection
- admission decisions
- simulator lifecycle management
- telemetry snapshots
- SSE streaming to the dashboard

### Frontend

The frontend resides in `public/` and includes:

- [public/index.html](/home/tamatar/Documents/College/bisek/public/index.html): visitor gateway page
- [public/site.html](/home/tamatar/Documents/College/bisek/public/site.html): protected content page
- [public/blocked.html](/home/tamatar/Documents/College/bisek/public/blocked.html): denial page
- [public/admin.html](/home/tamatar/Documents/College/bisek/public/admin.html): live dashboard
- [public/gateway.js](/home/tamatar/Documents/College/bisek/public/gateway.js): visitor-side gateway logic
- [public/admin.js](/home/tamatar/Documents/College/bisek/public/admin.js): dashboard rendering and control logic
- [public/style.css](/home/tamatar/Documents/College/bisek/public/style.css): shared visual styling

### Simulator and Launchers

The bounded simulator and launch scripts are:

- [ddos-test.js](/home/tamatar/Documents/College/bisek/ddos-test.js)
- [test-it.bat](/home/tamatar/Documents/College/bisek/test-it.bat)
- [start-server.bat](/home/tamatar/Documents/College/bisek/start-server.bat)

Despite the historical filename `ddos-test.js`, the current script is a bounded local pressure controller. It is not a general-purpose attack utility.

## API Specification

### `POST /api/request-access`

Requests entry through the gateway.

Possible outcomes:

- access allowed with token
- access denied due to full concurrent capacity
- access denied due to temporary surge throttling

Example success response:

```json
{
  "allowed": true,
  "token": "abc123...",
  "reused": false
}
```

Example surge-throttled response:

```json
{
  "allowed": false,
  "reason": "surge-throttled",
  "message": "Traffic spike detected. New entries are temporarily limited to 20/s."
}
```

Example capacity-full response:

```json
{
  "allowed": false,
  "reason": "capacity-full",
  "message": "Capacity is full right now."
}
```

### `POST /api/leave`

Releases a session token and frees the occupied slot.

### `GET /api/status`

Returns the full telemetry snapshot used by the dashboard and console controller.

### `GET /api/dashboard/stream`

Streams real-time updates to the dashboard using Server-Sent Events.

### `POST /api/simulator/start`

Starts the bounded local simulator.

Restriction:

- localhost only

Optional body:

```json
{
  "durationSeconds": 30
}
```

### `POST /api/simulator/stop`

Stops the simulator and returns pool agents to idle.

Restriction:

- localhost only

## Default Configuration

The key default values in the current implementation are:

- `PORT = 3000`
- `MAX_USERS = 5`
- `USER_TIMEOUT_MS = 60000`
- `ENTRY_RATE_LIMIT_PER_SECOND = 20`
- `RATE_BASELINE_WINDOW_SECONDS = 12`
- `SURGE_STDDEV_MULTIPLIER = 1.5`
- `SURGE_MIN_ABSOLUTE_DELTA = 3`
- `SURGE_COOLDOWN_MS = 10000`
- `SIMULATOR_POOL_SIZE = ceil(MAX_USERS * 1.5)`
- `SIMULATOR_PARALLEL_LIMIT = max(2, ceil(MAX_USERS * 0.75))`

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Server port |
| `MAX_USERS` | `5` | Maximum concurrent active sessions |
| `USER_TIMEOUT_MS` | `60000` | Session lifetime |
| `ENTRY_RATE_LIMIT_PER_SECOND` | `20` | Temporary admission cap during surge mode |
| `SERVER` | `http://localhost:3000` | Target used by the console controller |
| `DEMO_DURATION_SECONDS` | `30` | Simulator runtime |

## Reproducibility and Execution

### Install Dependencies

```bash
npm install
```

### Start the Server

```bash
npm start
```

Or on Windows:

```bat
start-server.bat
```

### Run the Bounded Simulator

```bash
npm run demo
```

Or on Windows:

```bat
test-it.bat
```

### Alternate Port Example

If port `3000` is already occupied:

```bash
PORT=3100 node server.js
SERVER=http://localhost:3100 DEMO_DURATION_SECONDS=30 node ddos-test.js
```

## Suggested Experimental Procedure

For a classroom presentation, demonstration, or small-scale research observation, the following sequence is suitable:

1. Start the server.
2. Open the visitor page at `http://localhost:3000/`.
3. Open the admin dashboard at `http://localhost:3000/admin.html`.
4. Record the stable baseline condition.
5. Start the simulator.
6. Observe active occupancy, block rate, and surge-state transitions.
7. Note whether denials are caused by concurrent capacity or surge throttling.
8. Repeat with modified environment variables if comparative analysis is needed.

## Suggested Evaluation Angles for a Paper

This implementation supports discussion under headings such as:

- concurrent-access protection under limited capacity
- adaptive response to anomalous entry-rate deviation
- interpretability of gateway decisions through live telemetry
- tradeoff between availability and protection during temporary spikes
- safe bounded simulation for research demonstration

## Limitations

This prototype intentionally simplifies many real-world concerns:

- session state is stored in memory only
- no persistent storage is used
- the IP model is simplistic and suitable only for local demonstration
- dashboard access is not protected by a full authentication system
- localhost restriction is used for simulator controls rather than production-grade authorization
- the anomaly detector is educational and heuristic, not statistically rigorous enough for production defense
- the model does not represent distributed infrastructure, upstream filtering, geographic traffic distribution, or real network-layer attacks
- concurrent admission count is a logical gateway metric, not a direct measure of CPU, memory, or bandwidth exhaustion

These limitations should be acknowledged explicitly in any paper that discusses the system.

## Threats to Validity

If this project is used as part of a research paper, the following validity concerns should be noted:

- external validity is limited because the test environment is local and bounded
- construct validity is limited because "attack pressure" is represented through synthetic controlled clients, not real adversarial internet-scale behavior
- ecological validity is limited because the prototype does not sit in front of a real distributed service stack
- performance claims should not be generalized beyond the prototype context

## Suitable Academic Positioning

The most accurate academic framing for this repository is:

"A local research prototype for adaptive web-entry admission control under anomalous traffic conditions."

That framing is more defensible than describing the project as a full DDoS defense platform or as a reimplementation of a commercial edge-security provider.

## Project Structure

| File | Role in the Research Prototype |
| --- | --- |
| [server.js](/home/tamatar/Documents/College/bisek/server.js) | Core gateway logic, session store, surge detector, simulator management, telemetry APIs |
| [ddos-test.js](/home/tamatar/Documents/College/bisek/ddos-test.js) | Console-based bounded pressure controller |
| [test-it.bat](/home/tamatar/Documents/College/bisek/test-it.bat) | Windows launcher for the simulator |
| [start-server.bat](/home/tamatar/Documents/College/bisek/start-server.bat) | Windows launcher for the backend |
| [public/index.html](/home/tamatar/Documents/College/bisek/public/index.html) | Visitor entry page |
| [public/gateway.js](/home/tamatar/Documents/College/bisek/public/gateway.js) | Visitor-side admission flow |
| [public/site.html](/home/tamatar/Documents/College/bisek/public/site.html) | Protected page reached after admission |
| [public/blocked.html](/home/tamatar/Documents/College/bisek/public/blocked.html) | Denial page for capacity or surge cases |
| [public/admin.html](/home/tamatar/Documents/College/bisek/public/admin.html) | Live monitoring interface |
| [public/admin.js](/home/tamatar/Documents/College/bisek/public/admin.js) | Dashboard data rendering and control actions |
| [public/style.css](/home/tamatar/Documents/College/bisek/public/style.css) | Shared styling |
| [package.json](/home/tamatar/Documents/College/bisek/package.json) | Dependency and script configuration |

## Conclusion

This project presents a small but coherent cybersecurity research prototype for studying surge-aware admission control at the entrance of a protected web service. Its main value lies in showing, in an inspectable and bounded way, how concurrent-capacity enforcement, rolling rate analysis, and temporary throttling can work together. The implementation is intentionally limited and should be described as a prototype, but it is appropriate for college-level discussion, demonstration, and exploratory analysis of adaptive gateway behavior.
