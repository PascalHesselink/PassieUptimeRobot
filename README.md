# PassieUptimeRobot

**Self-hosted website uptime & SSL certificate monitor with instant email alerts**  
Lightweight, Docker-ready, and free to run on your own server.

---

## Features
- Monitor website **uptime**, **response time**, and **SSL certificate** status.
- Email alerts when a site goes **down**, **comes back up**, or SSL changes/expiring.
- Store monitoring history in a **database**.
- Multiple users with per-site alert subscriptions.
- **Docker** support for quick deployment.

---

## Install & Run Locally (Development)

### 1. Clone the repository
```bash
git clone https://github.com/PascalHesselink/PassieUptimeRobot.git
cd PassieUptimeRobot
````

### 2. Install dependencies

```bash
npm install
```

### 3. Configure `.env`

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=passie
DB_PASS=passiepass
DB_NAME=passie_uptime

MAIL_ENABLED=true
MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your@email.com
SMTP_PASS=your_app_password
MAIL_FROM="PassieUptimeRobot <no-reply@yourdomain.com>"
```

### 4. Start locally

```bash
node server.js
```

### 5. Send a test email locally

```bash
node test-mail.js
```

---

## Run on Ubuntu (Production)

### 1. Install Docker & Docker Compose

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
```

### 2. Upload project & `.env` to server

```bash
scp -r ./PassieUptimeRobot user@your-server:/opt/
```

### 3. Start with Docker Compose

```bash
cd /opt/PassieUptimeRobot
docker compose up -d --build
```

### 4. View logs

```bash
docker compose logs -f app
```

### 5. Send a test email in container

```bash
docker compose exec app node /app/test-mail.js
```

---

## Notes

* MySQL database is stored in a **named Docker volume** (`dbdata`), so restarts/rebuilds keep your data unless you run `docker compose down -v`.
* `.env` file stays on the host and is reused for every start.