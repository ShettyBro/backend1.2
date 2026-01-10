// college-and-usn.js
const sql = require('mssql');

console.log('Environment check:', {
  hasUser: !!process.env.DB_USER,
  hasPassword: !!process.env.DB_PASSWORD,
  hasServer: !!process.env.DB_SERVER,
  hasDatabase: !!process.env.DB_NAME,
  serverValue: process.env.DB_SERVER
});

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

    // ===== GET: Fetch all colleges =====
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
        SELECT college_id, college_name, college_code, place
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

    // ===== POST: Handle actions =====
    if (event.httpMethod === 'POST') {

      if (!event.body) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Missing request body" }),
        };
      }

      let body;
      try {
        body = JSON.parse(event.body);
      } catch (e) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Invalid JSON" }),
        };
      }

      const { action, usn } = body;


      // ACTION: check_usn
      if (action === 'check_usn') {
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



      // ACTION: validate_and_fetch_college
      if (action === 'validate_and_fetch_college') {
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
            SELECT 
              s.student_id,
              s.college_id,
              c.college_code,
              c.college_name,
              c.place
            FROM students s
            INNER JOIN colleges c ON s.college_id = c.college_id
            WHERE s.usn = @usn
          `);

        if (result.recordset.length === 0) {
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({
              exists: false,
              error: 'Invalid USN. Please check and try again or register first.'
            }),
          };
        }

        const studentData = result.recordset[0];

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            exists: true,
            student_id: studentData.student_id,
            college_id: studentData.college_id,
            college_code: studentData.college_code,
            college_name: studentData.college_name,
            place: studentData.place
          }),
        };
      }

      // Invalid action
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid action' }),
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
      body: JSON.stringify({
        error: 'An error occurred processing your request',
        details: error.message
      }),
    };
  } finally {
    if (pool) {
      await pool.close();
    }
  }
};