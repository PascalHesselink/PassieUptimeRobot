const nodemailer = require('nodemailer')

function buildTransport() {
    if (process.env.MAIL_TRANSPORT === 'gmail') {
        return nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
        })
    }
    if (process.env.MAIL_TRANSPORT === 'smtp') {
        return nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT || 587),
            secure: process.env.SMTP_SECURE === 'true',
            auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
        })
    }
    if (process.env.MAIL_TRANSPORT === 'sendgrid') {
        return nodemailer.createTransport({
            host: 'smtp.sendgrid.net',
            port: 587,
            auth: { user: 'apikey', pass: process.env.SENDGRID_API_KEY }
        })
    }
    if (process.env.MAIL_TRANSPORT === 'postmark') {
        return nodemailer.createTransport({
            host: 'smtp.postmarkapp.com',
            port: 587,
            auth: { user: process.env.POSTMARK_SERVER_TOKEN, pass: process.env.POSTMARK_SERVER_TOKEN }
        })
    }
    throw new Error('MAIL_TRANSPORT not configured')
}

const transporter = buildTransport()

async function sendEmail(to, subject, text) {
    const from = process.env.MAIL_FROM || 'PassieUptimeRobot <no-reply@localhost>'
    const info = await transporter.sendMail({ from, to, subject, text })
    console.log(`\x1b[31mEMAIL SENT\x1b[0m to=${to} subject="${subject}" id=${info.messageId || 'n/a'}`)
    return info
}

module.exports = { sendEmail }
