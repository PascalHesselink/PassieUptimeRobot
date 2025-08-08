# PassieUptimeRobot

**Self-hosted uptime & SSL monitoring with email alerts — lightweight, fast, and subscription-free.**

PassieUptimeRobot is a Node.js application that monitors websites for uptime, response time, and SSL status.  
It stores all history in SQLite and can send customizable email alerts when:

- A website goes **down** or comes **back up** (with downtime duration).
- SSL certificate becomes **invalid** or **changes**.
- SSL certificate is about to **expire** (daily alerts within a configurable threshold).

---

## Features

- **Lightweight** — no heavy dependencies; works anywhere with Node.js and `curl`.
- **Per-site refresh intervals** — check critical sites every minute, others less often.
- **SSL monitoring** — expiration warnings, certificate changes, validity tracking.
- **Persistent storage** — SQLite database `monitor.db`.
- **Detailed stats** — response times, HTTP status, and error output (failures only).
- **Multi-user notifications** — assign which users receive alerts for each site.
- **Duplicate alert prevention** — won’t send the same alert twice.
- **Docker support** — easy deployment on any server or cloud instance.
- **Works offline** — no external monitoring services required.

---

## Requirements

- Node.js **v20** or newer
- `curl` installed on the system
- SQLite (bundled with Node module `better-sqlite3`)
- SMTP credentials for email sending (e.g., Gmail App Password, Mailgun, SendGrid)

---

## Installation

### 1. Clone the repository
```bash
git clone https://github.com/PascalHesselink/PassieUptimeRobot.git
cd passie-uptime-robot
```

### 2. Install dependencies
```bash
npm install
```

### 3. Configure environment variables
Create a `.env` file in the project root:

```env
MAIL_TRANSPORT=smtp
MAIL_HOST=smtp.gmail.com
MAIL_PORT=587
MAIL_SECURE=false
MAIL_USER=your@email.com
MAIL_PASS=your_app_password
MAIL_FROM="PassieUptimeRobot <no-reply@yourdomain.com>"

# Optional: seed initial targets (comma-separated URLs)
TARGET_URLS=https://example.com,https://another-site.com
```

> If using Gmail, enable **2FA** and create an **App Password**.

---

## Running without Docker

```bash
node server.js
```

The scheduler runs every second and checks sites according to their individual refresh interval.

---

## Running with Docker

### Build and run
```bash
docker build -t passie-uptime-robot .
docker run -d \
  --name passie-uptime-robot \
  --env-file .env \
  -v $(pwd)/monitor.db:/app/monitor.db \
  passie-uptime-robot
```

### Or with Docker Compose
```bash
docker-compose up -d
```

---

## Database Structure

Main tables:
- `target_urls` — list of monitored sites with settings.
- `target_url_stats` — history of uptime checks.
- `target_url_ssl` — SSL certificate snapshots.
- `users` — notification recipients.
- `target_url_user` — mapping between sites and users.
- `notifications` — log of sent alerts (prevents duplicates).

---

## Email Notifications

PassieUptimeRobot sends alerts for:
- Website DOWN
- Website UP (with downtime duration)
- SSL changed
- SSL invalid
- SSL expiry warnings (daily until fixed or expired)

---

## Example Usage

**Add a target site manually:**
```sql
INSERT INTO target_urls (name, url, refresh_seconds, timeout_seconds)
VALUES ('Example', 'https://example.com', 60, 30);
```

**Add a user:**
```sql
INSERT INTO users (name, email)
VALUES ('John Doe', 'john@example.com');
```

**Link user to a site:**
```sql
INSERT INTO target_url_user (target_url_id, user_id) VALUES (1, 1);
```

---

## Development

Run with hot reload:
```bash
npm install -g nodemon
nodemon server.js
```

---

## License

MIT License.  
Feel free to fork and customize.