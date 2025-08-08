const mysql = require('mysql2/promise')

const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
})

async function query(sql, params) {
    const [rows] = await pool.execute(sql, params)
    return rows
}

async function run(sql, params) {
    const [res] = await pool.execute(sql, params)
    return res
}

module.exports = { pool, query, run }
