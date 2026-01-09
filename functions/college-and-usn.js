// college-and-usn.js
const sql = require('mssql');

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: {
    encrypt: true,
    trustServerCertificate: false,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  let pool;

  try {
    pool = await sql.connect(dbConfig);

    if (event.httpMethod === 'GET') {
      const action = event.queryStringParameters?.action;

      if (action !== 'get_colleges') {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid action parameter' }),
        };
      }

      const result = await pool.request().query(`
        SELECT college_id, college_name, college_code
        FROM colleges
        WHERE is_active = 1
        ORDER BY college_name ASC
      `);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ colleges: result.recordset }),
      };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { action, usn } = body;

      if (action !== 'check_usn') {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid action' }),
        };
      }

      if (!usn || typeof usn !== 'string' || !usn.trim()) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'USN is required' }),
        };
      }

      const normalizedUSN = usn.trim().toUpperCase();

      const result = await pool
        .request()
        .input('usn', sql.VarChar(50), normalizedUSN)
        .query(`
          SELECT student_id
          FROM students
          WHERE usn = @usn
        `);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ exists: result.recordset.length > 0 }),
      };
    }

    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  } catch (error) {
    console.error('Error in college-and-usn:', error);

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'An error occurred processing your request' }),
    };
  } finally {
    if (pool) {
      await pool.close();
    }
  }
};